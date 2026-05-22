import type { IConversation } from "@kokoro/db";
import { logger } from "@kokoro/shared";
import { ingestSession } from "./index";
import { buildTranscript, transcriptHasContent } from "./transcript";

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
    convo.ingestAttempts = (convo.ingestAttempts ?? 0) + 1;
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
