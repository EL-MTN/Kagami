import type { IConversation } from "@kokoro/db";
import { logger } from "@kokoro/shared";
import { ingestSession, KiokuClientError } from "./index";
import { buildTranscript, transcriptHasContent } from "./transcript";

// Give up on a transcript after this many failures that re-running it won't
// fix. Past this it's marked terminally "failed" rather than retried by the
// sweeper forever. See countsTowardIngestCap for which failures count.
export const MAX_INGEST_ATTEMPTS = 5;

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
// On success: marks `ingestStatus: "done"` and records `ingestedAt`.
// On failure: leaves status as `"pending"` and bumps `ingestAttempts`;
// the sweeper retries on a future tick. Kioku is idempotent on retry
// (md5 dedup catches byte-identical extractions), and the sweeper
// probes `source_session` before re-ingesting to avoid creating
// paraphrased duplicates if the extraction LLM produces different
// wording the second time.
//
// Throws nothing. The chat path must never break because of memory.

async function runIngest(convo: IConversation): Promise<void> {
  const startedAt = Date.now();
  logger.info({ sessionId: convo.sessionId, chatId: convo.chatId }, "kioku ingest: starting");
  try {
    const result = await ingestSession({ transcript: buildTranscript(convo) });
    convo.ingestStatus = "done";
    convo.ingestedAt = new Date();
    await convo.save();
    logger.info(
      {
        sessionId: convo.sessionId,
        chatId: convo.chatId,
        added: result.added,
        batches: result.batches,
        failed: result.failed,
        durationMs: Date.now() - startedAt,
      },
      "kioku ingest: done",
    );
  } catch (err) {
    // Only charge an attempt — and eventually give up — for failures that
    // re-running this transcript won't fix (deterministic HTTP errors + client
    // timeouts). Transient signals (outage, 429/503) leave the session
    // "pending" for unbounded retry so a recovering Kioku still drains it.
    const countsTowardCap = countsTowardIngestCap(err);
    if (countsTowardCap) {
      convo.ingestAttempts = (convo.ingestAttempts ?? 0) + 1;
      if (convo.ingestAttempts >= MAX_INGEST_ATTEMPTS) {
        convo.ingestStatus = "failed";
      }
    }
    try {
      await convo.save();
    } catch (saveErr) {
      logger.warn(
        { error: saveErr, sessionId: convo.sessionId },
        "kioku ingest: failed to update ingestAttempts after error",
      );
    }
    logger.error(
      {
        error: err,
        sessionId: convo.sessionId,
        chatId: convo.chatId,
        attempts: convo.ingestAttempts,
        ingestStatus: convo.ingestStatus,
        countsTowardCap,
        durationMs: Date.now() - startedAt,
      },
      "kioku ingest: failed",
    );
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

// Awaited variant for the sweeper, which isn't latency-sensitive and
// wants to know when each ingest finishes so it can rate-limit.
export async function ingestClosedSessionAwaited(convo: IConversation): Promise<void> {
  if (!transcriptHasContent(convo)) {
    await markEmptyAsDone(convo);
    return;
  }
  await runIngest(convo);
}
