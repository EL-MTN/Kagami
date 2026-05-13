import { Conversation, PendingFact } from "@kokoro/db";
import { logger } from "@kokoro/shared";
import { appendFact, hasFactsForSession } from "./index";
import { ingestClosedSessionAwaited } from "./ingest";

// Sweepers backstop the per-call-site ingest trigger so we never lose a
// closed conversation to a Kioku outage, a forgotten future call site,
// or a session that just sits in "active" because the user never came
// back. The trigger is the latency optimization; the sweeper is the
// correctness layer.

export interface SweepPendingOptions {
  // Don't touch sessions closed within this window — gives the
  // immediate-trigger path time to land before the sweeper races it.
  stalenessMs?: number;
  maxPerSweep?: number;
}

export interface SweepPendingResult {
  scanned: number;
  reconciled: number; // already in Kioku, just updated status
  ingested: number; // actually ran ingest
  failed: number;
}

const DEFAULT_STALENESS_MS = 60_000;
const DEFAULT_MAX_PER_SWEEP = 10;
const DEFAULT_PENDING_FACT_MAX_PER_SWEEP = 25;
const DEFAULT_PENDING_FACT_MAX_ATTEMPTS = 5;
const DEFAULT_PENDING_FACT_BASE_BACKOFF_MS = 5 * 60_000;
const DEFAULT_PENDING_FACT_MAX_BACKOFF_MS = 60 * 60_000;

/**
 * Drive any closed conversation whose ingest is still pending to "done".
 * Matches both `ingestStatus: "pending"` and documents where the field
 * is absent — the latter covers legacy conversations that closed before
 * this field was added to the schema (Mongo's filter operates at the
 * storage layer; Mongoose schema defaults only fire at hydration).
 *
 * For each match, first probe Kioku to see if facts already exist for
 * the session — if so, just mark done (handles "ingest succeeded but
 * the status update lost the race", and avoids paraphrased-duplicate
 * facts on retry). Otherwise run a fresh ingest.
 */
export async function sweepPendingIngests(
  opts: SweepPendingOptions = {},
): Promise<SweepPendingResult> {
  const stalenessMs = opts.stalenessMs ?? DEFAULT_STALENESS_MS;
  const maxPerSweep = opts.maxPerSweep ?? DEFAULT_MAX_PER_SWEEP;
  const cutoff = new Date(Date.now() - stalenessMs);

  // Match documents where ingestStatus is "pending" OR missing — covers
  // legacy conversations that were closed before this field existed.
  // Mongoose's schema default fires at hydration, but Mongo's query
  // operates at the storage layer and won't match an absent field
  // against the literal "pending" string.
  const stale = await Conversation.find({
    status: "closed",
    closedAt: { $lt: cutoff },
    $or: [{ ingestStatus: "pending" }, { ingestStatus: { $exists: false } }],
  })
    .sort({ closedAt: 1 })
    .limit(maxPerSweep);

  const result: SweepPendingResult = {
    scanned: stale.length,
    reconciled: 0,
    ingested: 0,
    failed: 0,
  };

  for (const convo of stale) {
    const sessionTag = `raw/${convo.sessionId}`;
    try {
      const already = await hasFactsForSession(sessionTag);
      if (already) {
        convo.ingestStatus = "done";
        convo.ingestedAt = new Date();
        await convo.save();
        result.reconciled += 1;
        logger.info(
          { sessionId: convo.sessionId, chatId: convo.chatId },
          "kioku sweeper: reconciled (facts already in Kioku)",
        );
        continue;
      }
    } catch (err) {
      // Probe failure → log and try the ingest anyway. Kioku's md5 dedup
      // protects against duplicate exact-text facts; the worst case is a
      // paraphrased duplicate when the LLM phrases the same fact slightly
      // differently. Better than skipping a real ingest.
      logger.warn(
        { err: (err as Error).message, sessionId: convo.sessionId },
        "kioku sweeper: probe failed, attempting ingest anyway",
      );
    }

    const before = convo.ingestStatus;
    await ingestClosedSessionAwaited(convo);
    if (convo.ingestStatus === "done") {
      result.ingested += 1;
    } else {
      result.failed += 1;
      logger.warn(
        {
          sessionId: convo.sessionId,
          chatId: convo.chatId,
          before,
          attempts: convo.ingestAttempts,
        },
        "kioku sweeper: ingest still pending after attempt",
      );
    }
  }

  if (result.scanned > 0) {
    logger.info({ ...result }, "kioku sweeper: pending ingest sweep finished");
  }
  return result;
}

export interface SweepPendingFactsOptions {
  maxPerSweep?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: Date;
}

export interface SweepPendingFactsResult {
  scanned: number;
  appended: number;
  failed: number;
  abandoned: number;
}

export function nextPendingFactAttemptAt(
  attemptCount: number,
  now = new Date(),
  baseBackoffMs = DEFAULT_PENDING_FACT_BASE_BACKOFF_MS,
  maxBackoffMs = DEFAULT_PENDING_FACT_MAX_BACKOFF_MS,
): Date {
  const delay = Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.max(0, attemptCount - 1));
  return new Date(now.getTime() + delay);
}

export async function sweepPendingFacts(
  opts: SweepPendingFactsOptions = {},
): Promise<SweepPendingFactsResult> {
  const now = opts.now ?? new Date();
  const maxPerSweep = opts.maxPerSweep ?? DEFAULT_PENDING_FACT_MAX_PER_SWEEP;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_PENDING_FACT_MAX_ATTEMPTS;
  const baseBackoffMs = opts.baseBackoffMs ?? DEFAULT_PENDING_FACT_BASE_BACKOFF_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_PENDING_FACT_MAX_BACKOFF_MS;

  const due = await PendingFact.find({
    status: "pending",
    nextAttemptAt: { $lte: now },
  })
    .sort({ nextAttemptAt: 1, createdAt: 1 })
    .limit(maxPerSweep);

  const result: SweepPendingFactsResult = {
    scanned: due.length,
    appended: 0,
    failed: 0,
    abandoned: 0,
  };

  for (const pending of due) {
    if (pending.attemptCount >= maxAttempts) {
      pending.status = "failed";
      pending.failedAt = now;
      pending.lastError = pending.lastError ?? "max attempts reached";
      await pending.save();
      result.abandoned += 1;
      continue;
    }

    try {
      await appendFact({
        text: pending.text,
        event_date: pending.eventDate,
        source_session: pending.sourceSession,
        user_id: pending.userId,
      });
      await PendingFact.deleteOne({ _id: pending._id });
      result.appended += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : "pending fact append failed";
      const nextAttemptCount = pending.attemptCount + 1;
      pending.attemptCount = nextAttemptCount;
      pending.lastAttemptAt = now;
      pending.lastError = reason;
      if (nextAttemptCount >= maxAttempts) {
        pending.status = "failed";
        pending.failedAt = now;
        result.abandoned += 1;
      } else {
        pending.nextAttemptAt = nextPendingFactAttemptAt(
          nextAttemptCount,
          now,
          baseBackoffMs,
          maxBackoffMs,
        );
        result.failed += 1;
      }
      await pending.save();
      logger.warn(
        {
          err: reason,
          sourceSession: pending.sourceSession,
          attempts: nextAttemptCount,
          status: pending.status,
        },
        "kioku sweeper: pending fact append failed",
      );
    }
  }

  if (result.scanned > 0) {
    logger.info({ ...result }, "kioku sweeper: pending fact sweep finished");
  }
  return result;
}

export interface SweepStaleActiveOptions {
  // How long an active session can sit idle before the sweeper closes it.
  // Default 6h is well past `getOrCreateSession`'s 1h auto-close
  // threshold; this is for sessions that never got a "next message" to
  // trigger that path.
  idleHours?: number;
  maxPerSweep?: number;
}

export interface SweepStaleActiveResult {
  closed: number;
}

const DEFAULT_IDLE_HOURS = 6;
const DEFAULT_MAX_ACTIVE_PER_SWEEP = 50;

/**
 * Close any `active` sessions that haven't been touched in a long time.
 * Marks them `closed` (with `closedAt`) and leaves `ingestStatus:
 * "pending"` — the next `sweepPendingIngests` tick picks them up.
 */
export async function sweepStaleActiveSessions(
  opts: SweepStaleActiveOptions = {},
): Promise<SweepStaleActiveResult> {
  const idleHours = opts.idleHours ?? DEFAULT_IDLE_HOURS;
  const maxPerSweep = opts.maxPerSweep ?? DEFAULT_MAX_ACTIVE_PER_SWEEP;
  const cutoff = new Date(Date.now() - idleHours * 60 * 60_000);

  const stale = await Conversation.find({
    status: "active",
    updatedAt: { $lt: cutoff },
  })
    .sort({ updatedAt: 1 })
    .limit(maxPerSweep);

  for (const convo of stale) {
    convo.status = "closed";
    convo.closedAt = new Date();
    // Explicit even though "pending" is the schema default — legacy
    // documents that pre-date the field would otherwise be saved with
    // it absent, and the next sweepPendingIngests query filters on it.
    convo.ingestStatus = "pending";
    await convo.save();
  }

  if (stale.length > 0) {
    logger.info({ closed: stale.length, idleHours }, "kioku sweeper: closed stale active sessions");
  }
  return { closed: stale.length };
}
