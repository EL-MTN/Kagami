import { describe, expect, it, vi } from "vitest";

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

// Don't actually launch Chromium. We only test the lock/timeout state machine.
vi.mock("@browserbasehq/stagehand", () => ({
  Stagehand: vi.fn(),
}));

import { withBrowserLock } from "../../src/services/browser";

describe("withBrowserLock — timeout path", () => {
  it("rejects with a 'timed out' error when fn does not settle", async () => {
    const start = Date.now();
    await expect(
      withBrowserLock(() => new Promise<void>(() => undefined), {
        timeoutMs: 50,
        label: "test:hang",
      }),
    ).rejects.toThrow(/timed out after 50ms \(test:hang\)/);
    // Sanity check: timeout actually fired, didn't wait for fn.
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("releases the lock after a timeout so the next caller proceeds", async () => {
    // First call hangs and times out.
    await expect(
      withBrowserLock(() => new Promise<void>(() => undefined), { timeoutMs: 30 }),
    ).rejects.toThrow(/timed out/);

    // Next caller must run — if shutdownBrowser hadn't reset state cleanly,
    // or release() didn't fire, this would hang forever.
    const result = await withBrowserLock(() => Promise.resolve("ok"), { timeoutMs: 1000 });
    expect(result).toBe("ok");
  });

  it("does not time out when fn settles within the budget", async () => {
    const result = await withBrowserLock(() => Promise.resolve(42), {
      timeoutMs: 1000,
      label: "test:fast",
    });
    expect(result).toBe(42);
  });

  it("propagates errors thrown inside fn without flagging them as timeouts", async () => {
    await expect(
      withBrowserLock(() => Promise.reject(new Error("boom")), { timeoutMs: 1000 }),
    ).rejects.toThrow(/^boom$/);
  });
});
