import { logger, withRootTrace } from "@kokoro/shared";
import type { AdapterRegistry } from "../platform/registry";
import { runRoutineSelfReview } from "../services/routine-review";

// Routine hygiene is a slow-moving concern — a weekly audit is plenty, and the
// durable anti-nag store means a restart-heavy week still can't spam the user.
const REVIEW_INTERVAL_MS = 7 * 24 * 60 * 60_000; // weekly
// Wait until the bot is fully up (adapters registered, MCP connected) before
// the first audit so adapter resolution succeeds.
const STARTUP_DELAY_MS = 5 * 60_000; // 5 minutes

let interval: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

export function startRoutineReviewScheduler(registry: AdapterRegistry): () => void {
  // Each run is its own root trace so the audit's LLM calls and any downstream
  // Kioku/Kizuna reads share one traceId, and proposal bubbles correlate back.
  interval = setInterval(
    withRootTrace(() => {
      runRoutineSelfReview(registry).catch((error) => {
        logger.error({ error }, "Routine self-review interval failed");
      });
    }),
    REVIEW_INTERVAL_MS,
  );
  interval.unref();

  startupTimer = setTimeout(
    withRootTrace(() => {
      runRoutineSelfReview(registry).catch((error) => {
        logger.error({ error }, "Startup routine self-review failed");
      });
    }),
    STARTUP_DELAY_MS,
  );
  startupTimer.unref();

  logger.info("Routine self-review scheduler started");

  return () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    logger.info("Routine self-review scheduler stopped");
  };
}
