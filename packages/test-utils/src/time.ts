import { vi } from "vitest";

/**
 * Advance fake timers by `ms`, awaiting any microtasks each tick triggers.
 * Wrapper exists mainly to flag suites that need `vi.useFakeTimers()` set up
 * via a beforeEach.
 */
export async function advanceTimersByAsync(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}
