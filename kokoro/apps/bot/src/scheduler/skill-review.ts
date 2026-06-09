import type { AdapterRegistry } from "../platform/registry";
import { runSkillSelfReview } from "../services/skill-review";
import { startPeriodicReview } from "./review-scheduler";

// Skill libraries drift slowly — weekly curation matches the routine
// self-review cadence, and the durable anti-nag store means a restart-heavy
// week still can't spam the user.
const REVIEW_INTERVAL_MS = 7 * 24 * 60 * 60_000; // weekly
// Staggered well past the routine review's 5-minute startup pass so the two
// passes don't race for the chat's single pending-proposal slot on a fresh
// boot (whichever raises first would suppress the other's proposal anyway —
// this just makes the ordering deterministic: routines get first claim).
const STARTUP_DELAY_MS = 15 * 60_000; // 15 minutes

export function startSkillReviewScheduler(registry: AdapterRegistry): () => void {
  return startPeriodicReview({
    label: "skill-review",
    intervalMs: REVIEW_INTERVAL_MS,
    startupDelayMs: STARTUP_DELAY_MS,
    run: () => runSkillSelfReview(registry),
  });
}
