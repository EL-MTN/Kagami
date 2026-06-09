import { logger, withRootTrace } from "@kokoro/shared";

/**
 * Generic interval-plus-delayed-first-run scheduler shared by the self-review
 * passes (routine self-review, skill curation). Each run is its own root trace
 * so the pass's LLM calls and any downstream reads share one traceId, and
 * proposal bubbles correlate back. Both timers are unref'd so they never hold
 * the process open. Returns a stop function.
 */
export function startPeriodicReview(opts: {
  /** Stable pass identifier, bound to every log line as `review`. */
  label: string;
  intervalMs: number;
  /** Delay before the first run — give startup (adapter registration, MCP
   * connect) time to finish so the pass can resolve adapters. */
  startupDelayMs: number;
  run: () => Promise<void>;
}): () => void {
  const { label, intervalMs, startupDelayMs, run } = opts;

  const fire = (failureMessage: string) =>
    withRootTrace(() => {
      run().catch((error) => {
        logger.error({ error, review: label }, failureMessage);
      });
    });

  // The recurring interval is registered only when the startup timer fires, so
  // every tick inherits the pass's startup offset. Registered at boot it would
  // anchor all passes' ticks to the same instant: the routine and skill
  // schedulers start back-to-back, both weekly ticks would fire together,
  // race the read-only one-pending guard before either creates its row, and
  // stack two confirmations — the exact iMessage invariant the guard protects.
  let interval: ReturnType<typeof setInterval> | undefined;
  const startupTimer = setTimeout(() => {
    interval = setInterval(fire("Self-review interval run failed"), intervalMs);
    interval.unref();
    fire("Self-review startup run failed")();
  }, startupDelayMs);
  startupTimer.unref();

  logger.info({ review: label }, "Self-review scheduler started");

  return () => {
    if (interval !== undefined) clearInterval(interval);
    clearTimeout(startupTimer);
    logger.info({ review: label }, "Self-review scheduler stopped");
  };
}
