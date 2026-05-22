import type { IConversation } from "@kokoro/db";
import { logger } from "@kokoro/shared";
import { ingestSession, KiokuClientError } from "./index";
import { buildTranscript, transcriptHasContent } from "./transcript";

// Give up on a transcript after this many attempts in which Kioku *responded*
// with an error (e.g. a 500 because every extraction batch failed). Re-running
// the identical transcript through the identical pipeline won't self-heal, so
// past this it's marked terminally "failed" rather than retried by the sweeper
// forever. Outage/timeout errors (Kioku unreachable) don't count toward this —
// those stay "pending" for unbounded retry until Kioku comes back.
export const MAX_INGEST_ATTEMPTS = 5;

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
    // Only charge an attempt — and eventually give up — when Kioku actually
    // responded (KiokuClientError carries a status only for HTTP error
    // responses; timeouts and transport errors leave it undefined). A
    // responded error (e.g. 500 from a total extraction failure) is
    // deterministic for this transcript and won't self-heal on retry, so it
    // counts toward the cap. An unreachable Kioku leaves the session
    // "pending" with no attempt charged, so a Kioku outage recovers via
    // unbounded sweeper retries once it comes back — it never burns the cap.
    const kiokuResponded = err instanceof KiokuClientError && err.status !== undefined;
    if (kiokuResponded) {
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
        kiokuResponded,
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
