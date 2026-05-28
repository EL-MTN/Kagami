import { Conversation, type IConversation } from "@kokoro/db";
import { logger } from "@kokoro/shared";
import { ingestSession, KiokuClientError } from "./index";
import { buildTranscript, transcriptHasContent } from "./transcript";

// Give up on a transcript after this many failures that re-running it won't
// fix. Past this it's marked terminally "failed" rather than retried by the
// sweeper forever. See countsTowardIngestCap for which failures count.
export const MAX_INGEST_ATTEMPTS = 5;

// How long a claim on a session's ingest is held. Comfortably longer than the
// 180s ingest client timeout so a legitimately in-flight ingest is never
// double-run; short enough that a worker that crashed mid-ingest frees the
// session for retry reasonably soon.
const INGEST_LEASE_MS = 5 * 60 * 1000;

// Outcome of an ingest attempt, so the sweeper can account accurately without
// re-reading the (possibly concurrently-updated) conversation document.
//   done      — facts extracted, status "done"
//   retry     — failed but left "pending" for a future sweep (transient, or
//               deterministic-but-below-cap)
//   abandoned — deterministic failure crossed the cap, status terminal "failed"
//   skipped   — another worker holds the lease; we did nothing
type IngestOutcome = "done" | "retry" | "abandoned" | "skipped";

// Whether an ingest failure should count toward the abandonment cap. The cap
// exists to stop retrying a transcript that will never succeed — NOT to give
// up during a transient outage. So:
//   - count   HTTP errors that are deterministic for this transcript: a 500
//             (every extraction batch failed) or a 4xx like 400 (malformed),
//     and   a client-side request timeout (Kioku was reachable but too slow —
//             re-running the same transcript won't be faster).
//   - skip    transient signals: connection/transport failures (Kioku down →
//             no status, not a timeout), and 429/503 ("retry later", which a
//             single 5/min-limited client hits in normal sweep bursts). These
//             stay "pending" for unbounded retry until Kioku recovers.
export function countsTowardIngestCap(err: unknown): boolean {
  if (!(err instanceof KiokuClientError)) return false;
  if (err.timedOut) return true;
  if (err.status === undefined) return false; // connection/transport failure
  if (err.status === 429 || err.status === 503) return false; // transient backpressure
  return true;
}

// Background ingest of a closed Kokoro conversation into Kioku. Two
// callers: the four session-rollover sites (latency optimization), and
// the sweeper (correctness safety net).
//
// Claims the session via an atomic lease so the immediate trigger and the
// sweeper never ingest it concurrently. On success: "done" + `ingestedAt`. On
// failure: releases the lease and either leaves it "pending" (transient or
// below-cap) or marks it terminal "failed" (deterministic, past the cap). The
// sweeper retries pending ones; Kioku is idempotent on retry and the sweeper
// also probes `source_session` first.
//
// Throws nothing. The chat path must never break because of memory.

// Atomically claim the session for ingest: only transitions a claimable row
// (pending/unset status AND a free/expired lease) to a fresh lease. Returns the
// claimed document, or null if another worker already holds it (or it's no
// longer pending). The conditional update is the serialization point.
async function claimForIngest(convo: IConversation): Promise<IConversation | null> {
  const now = new Date();
  return Conversation.findOneAndUpdate(
    {
      _id: convo._id,
      ingestStatus: { $in: ["pending", null] },
      $or: [
        { ingestLeaseUntil: { $exists: false } },
        { ingestLeaseUntil: null },
        { ingestLeaseUntil: { $lt: now } },
      ],
    },
    { $set: { ingestLeaseUntil: new Date(now.getTime() + INGEST_LEASE_MS) } },
    { returnDocument: "after" },
  );
}

async function runIngest(convo: IConversation): Promise<IngestOutcome> {
  // The claim is a DB call and must not escape: runIngest is called
  // fire-and-forget from the chat path (`void runIngest`), where an unhandled
  // rejection trips the process-level handler and shuts the bot down. A
  // transient Mongo error here leaves the session pending for the next sweep.
  let claimed: IConversation | null;
  try {
    claimed = await claimForIngest(convo);
  } catch (err) {
    logger.error({ error: err, sessionId: convo.sessionId }, "kioku ingest: claim failed");
    return "retry";
  }
  if (!claimed) {
    logger.debug(
      { sessionId: convo.sessionId },
      "kioku ingest: lease held by another worker (or no longer pending), skipping",
    );
    return "skipped";
  }

  const startedAt = Date.now();
  logger.info({ sessionId: claimed.sessionId, chatId: claimed.chatId }, "kioku ingest: starting");
  try {
    const result = await ingestSession({ transcript: buildTranscript(claimed) });
    claimed.ingestStatus = "done";
    claimed.ingestedAt = new Date();
    claimed.ingestLeaseUntil = null;
    await claimed.save();
    logger.info(
      {
        sessionId: claimed.sessionId,
        chatId: claimed.chatId,
        added: result.added,
        batches: result.batches,
        failed: result.failed,
        durationMs: Date.now() - startedAt,
      },
      "kioku ingest: done",
    );
    return "done";
  } catch (err) {
    // Only charge an attempt — and eventually give up — for failures that
    // re-running this transcript won't fix (deterministic HTTP errors + client
    // timeouts). Transient signals (outage, 429/503) leave the session
    // "pending" for unbounded retry so a recovering Kioku still drains it. We
    // hold the lease, so this read-modify-write is race-free.
    const countsTowardCap = countsTowardIngestCap(err);
    let outcome: IngestOutcome = "retry";
    if (countsTowardCap) {
      claimed.ingestAttempts = (claimed.ingestAttempts ?? 0) + 1;
      if (claimed.ingestAttempts >= MAX_INGEST_ATTEMPTS) {
        claimed.ingestStatus = "failed";
        outcome = "abandoned";
      }
    }
    // Release the lease so a still-"pending" session is immediately re-claimable
    // on the next sweep rather than waiting for the lease to expire.
    claimed.ingestLeaseUntil = null;
    try {
      await claimed.save();
    } catch (saveErr) {
      logger.warn(
        { error: saveErr, sessionId: claimed.sessionId },
        "kioku ingest: failed to update conversation after error",
      );
    }
    logger.error(
      {
        error: err,
        sessionId: claimed.sessionId,
        chatId: claimed.chatId,
        attempts: claimed.ingestAttempts,
        ingestStatus: claimed.ingestStatus,
        countsTowardCap,
        durationMs: Date.now() - startedAt,
      },
      "kioku ingest: failed",
    );
    return outcome;
  }
}

async function markEmptyAsDone(convo: IConversation): Promise<void> {
  if (convo.ingestStatus === "done") return;
  convo.ingestStatus = "done";
  convo.ingestedAt = new Date();
  try {
    await convo.save();
  } catch (err) {
    logger.warn(
      { error: err, sessionId: convo.sessionId },
      "kioku ingest: failed to mark empty session done",
    );
  }
}

// Fire-and-forget. Used at session-rollover call sites (generate.ts,
// acknowledge.ts, proactive.ts, confirmation-events.ts) to ingest
// without blocking the new turn. The sweeper backstops failures.
export function ingestClosedSession(convo: IConversation): void {
  if (!transcriptHasContent(convo)) {
    logger.debug(
      { sessionId: convo.sessionId },
      "skipping kioku ingest — closed session has no user content",
    );
    void markEmptyAsDone(convo);
    return;
  }
  void runIngest(convo);
}

// Awaited variant for the sweeper, which isn't latency-sensitive and wants the
// outcome so it can account accurately and rate-limit. Empty sessions are
// marked done with no Kioku call → "done".
export async function ingestClosedSessionAwaited(convo: IConversation): Promise<IngestOutcome> {
  if (!transcriptHasContent(convo)) {
    await markEmptyAsDone(convo);
    return "done";
  }
  return runIngest(convo);
}
