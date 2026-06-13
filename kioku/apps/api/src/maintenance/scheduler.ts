// In-process periodic consolidation — Kioku's self-contained maintenance
// timer. It runs a single durable-only entity-grouped curation pass
// (prompts/consolidate.md) over the default scope, dropping episodic
// chat-exhaust and folding fragmented episodes into one durable fact. This
// does NOT violate Kioku's pull-only posture: it is internal maintenance over
// the local store, never an outbound call to a sibling.
//
// Disabled by default (KIOKU_CONSOLIDATE_ENABLED). When enabled, the timer
// fires every KIOKU_CONSOLIDATE_INTERVAL_HOURS — one interval after boot,
// never at startup (a heavy LLM pass on every restart would be wasteful and
// could thrash the store in a crash loop). The same serialized run is also
// reachable via the guarded POST /consolidate route.

import { loadEnv } from "../config.js";
import { consolidationModel } from "../llm.js";
import { planCuration, applyCuration, type CurationApplyResult } from "../ingest/curate.js";
import { logger } from "../logger.js";

// Process-wide lock: the interval tick and a manual POST /consolidate must
// never run concurrently — two passes over the same store would race on the
// same deletes/merges and corrupt each other's stale-skip accounting.
let running = false;

// Whether a pass is currently in flight — lets the POST /consolidate route
// answer 409 without kicking off (and immediately no-op'ing) a second run.
export function isConsolidationRunning(): boolean {
  return running;
}

export interface ConsolidationRunOutcome {
  status: "ok" | "busy" | "error";
  result?: CurationApplyResult;
  error?: string;
}

// Run one durable-only consolidation pass over the default scope, serialized.
// A SINGLE entity-grouped pass — the LongMemEval-gated config (a converging
// multi-round re-review was tried and over-consolidated, regressing recall, so
// it was dropped). Returns "busy" if a pass is already in flight (the caller
// decides whether that's a benign skip or a 409). Never throws — a maintenance
// failure must not crash the timer or wedge a request handler.
export async function runConsolidationOnce(): Promise<ConsolidationRunOutcome> {
  if (running) {
    logger.info("consolidation pass skipped — a run is already in flight");
    return { status: "busy" };
  }
  running = true;
  const startedAt = Date.now();
  try {
    const plan = await planCuration(
      {},
      { grouping: "entity", policy: "consolidate", model: consolidationModel },
    );
    const result = await applyCuration(plan, "consolidate-cron");
    logger.info(
      {
        groups: plan.groups,
        failedGroups: plan.failedGroups,
        plannedDrops: plan.drops.length,
        plannedMerges: plan.merges.length,
        dropped: result.dropped,
        merged: result.merged,
        rewritten: result.rewritten,
        durationMs: Date.now() - startedAt,
      },
      "consolidation pass complete",
    );
    return { status: "ok", result };
  } catch (error) {
    logger.error({ error }, "consolidation pass failed");
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  } finally {
    running = false;
  }
}

export interface ConsolidationScheduler {
  stop(): void;
}

// Start the periodic consolidation timer if KIOKU_CONSOLIDATE_ENABLED. A no-op
// handle is returned when disabled, so server.ts can call stop() unconditionally
// on shutdown.
export function startConsolidationScheduler(): ConsolidationScheduler {
  const env = loadEnv();
  if (!env.KIOKU_CONSOLIDATE_ENABLED) {
    logger.info("consolidation cron disabled (KIOKU_CONSOLIDATE_ENABLED not 'true')");
    return { stop: () => {} };
  }

  const intervalHours = env.KIOKU_CONSOLIDATE_INTERVAL_HOURS;
  const intervalMs = intervalHours * 60 * 60 * 1000;
  logger.info(
    {
      intervalHours,
      editorModel: env.KIOKU_CONSOLIDATE_MODEL ?? env.LLM_MODEL ?? "(unset — reusing answerer)",
    },
    "consolidation cron enabled",
  );

  const timer = setInterval(() => {
    void runConsolidationOnce();
  }, intervalMs);
  // The maintenance timer must not keep the process alive on its own during a
  // graceful shutdown — server.close()/closeMongo() own process lifetime.
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
  };
}
