import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kokoro/shared", async (orig) => ({
  ...(await orig()),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

import { logger } from "@kokoro/shared";
import { startPeriodicReview } from "../../src/scheduler/review-scheduler";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("startPeriodicReview", () => {
  it("anchors the recurring interval to the startup delay, not to boot (ticks inherit the per-pass stagger)", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const stop = startPeriodicReview({ label: "t", intervalMs: 1000, startupDelayMs: 400, run });

    await vi.advanceTimersByTimeAsync(399);
    expect(run).toHaveBeenCalledTimes(0);

    // Startup run at +400.
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);

    // A boot-anchored interval would tick at +1000 — it must NOT. If it did,
    // the back-to-back routine and skill schedulers' weekly ticks would land
    // in the same instant and race the read-only one-pending guard.
    await vi.advanceTimersByTimeAsync(600); // t=1000
    expect(run).toHaveBeenCalledTimes(1);

    // First recurring tick at startupDelay + interval = +1400, then +2400.
    await vi.advanceTimersByTimeAsync(400); // t=1400
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000); // t=2400
    expect(run).toHaveBeenCalledTimes(3);

    stop();
  });

  it("stop() before the startup delay cancels everything", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const stop = startPeriodicReview({ label: "t", intervalMs: 1000, startupDelayMs: 400, run });

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
  });

  it("stop() after the startup run cancels the recurring interval", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const stop = startPeriodicReview({ label: "t", intervalMs: 1000, startupDelayMs: 400, run });

    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a rejecting run is caught and logged, and the schedule keeps going", async () => {
    const run = vi.fn().mockRejectedValue(new Error("boom"));
    const stop = startPeriodicReview({ label: "t", intervalMs: 1000, startupDelayMs: 400, run });

    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.error)).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000); // t=1400 — interval survives the failure
    expect(run).toHaveBeenCalledTimes(2);

    stop();
  });
});
