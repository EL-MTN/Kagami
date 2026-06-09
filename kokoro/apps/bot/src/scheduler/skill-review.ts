import type { AdapterRegistry } from "../platform/registry";
import { runSkillSelfReview } from "../services/skill-review";
import { startPeriodicReview } from "./review-scheduler";

// Skill libraries drift slowly — weekly curation matches the routine
// self-review cadence, and the durable anti-nag store means a restart-heavy
// week still can't spam the user.
const REVIEW_INTERVAL_MS = 7 * 24 * 60 * 60_000; // weekly
// Staggered well past the routine review's 5-minute startup pass so the boot
// ordering is deterministic: routines get first claim on the chat's single
// pending-proposal slot. Correctness doesn't ride on this delay — overlapping
// passes are serialized FIFO inside `runReviewForEachChat` — the stagger only
// decides who goes first. `startPeriodicReview` anchors the recurring interval
// to this delay, so the ordering persists across weekly ticks too.
const STARTUP_DELAY_MS = 15 * 60_000; // 15 minutes

export function startSkillReviewScheduler(registry: AdapterRegistry): () => void {
  return startPeriodicReview({
    label: "skill-review",
    intervalMs: REVIEW_INTERVAL_MS,
    startupDelayMs: STARTUP_DELAY_MS,
    run: () => runSkillSelfReview(registry),
  });
}
