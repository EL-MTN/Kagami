import type { AdapterRegistry } from "../platform/registry";
import { runRoutineSelfReview } from "../services/routine-review";
import { startPeriodicReview } from "./review-scheduler";

// Routine hygiene is a slow-moving concern — a weekly audit is plenty, and the
// durable anti-nag store means a restart-heavy week still can't spam the user.
const REVIEW_INTERVAL_MS = 7 * 24 * 60 * 60_000; // weekly
// Wait until the bot is fully up (adapters registered, MCP connected) before
// the first audit so adapter resolution succeeds.
const STARTUP_DELAY_MS = 5 * 60_000; // 5 minutes

export function startRoutineReviewScheduler(registry: AdapterRegistry): () => void {
  return startPeriodicReview({
    label: "routine-self-review",
    intervalMs: REVIEW_INTERVAL_MS,
    startupDelayMs: STARTUP_DELAY_MS,
    run: () => runRoutineSelfReview(registry),
  });
}
