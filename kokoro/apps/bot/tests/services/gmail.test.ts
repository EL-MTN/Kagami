import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @kokoro/shared just to silence the logger (the gmail.ts catch path
// calls logger.error on the swallow-to-null branch).
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

// Intercept withFreshAuth so we can plant arbitrary errors thrown "from
// Google" and assert how gmail.ts's catch routes them.
const { mockWithFreshAuth } = vi.hoisted(() => ({ mockWithFreshAuth: vi.fn() }));
vi.mock("../../src/services/google-auth", () => ({
  withFreshAuth: mockWithFreshAuth,
}));

import { getEmailById, getOwnerAddress } from "../../src/services/gmail";
import {
  KaoMisconfiguredError,
  KaoNoGrantError,
  KaoUnreachableError,
} from "../../src/services/kao-client";

beforeEach(() => {
  mockWithFreshAuth.mockReset();
});

// getEmailById's contract distinguishes operator-actionable Kao errors
// (re-thrown so the tool layer can show a re-consent / misconfig / Kao-down
// banner) from per-message Gmail errors (swallowed to null, the
// pre-existing behavior). The behavior is contract-significant: without
// these tests, a future refactor of the catch could silently revert to
// "everything → null" and the operator would see "no email" instead of an
// actionable signal.

describe("gmail.getEmailById — re-throw contract for Kao errors", () => {
  it("propagates KaoNoGrantError so the operator sees a re-consent prompt", async () => {
    mockWithFreshAuth.mockRejectedValueOnce(
      new KaoNoGrantError(
        "invalid_grant",
        "re-consent at https://api.kao.localhost/oauth/kokoro/start",
      ),
    );
    await expect(getEmailById("msg-1")).rejects.toBeInstanceOf(KaoNoGrantError);
  });

  it("propagates KaoNoGrantError with code=decrypt_failed too", async () => {
    mockWithFreshAuth.mockRejectedValueOnce(new KaoNoGrantError("decrypt_failed", "rotated key"));
    const err = await getEmailById("msg-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaoNoGrantError);
    expect((err as KaoNoGrantError).code).toBe("decrypt_failed");
  });

  it("propagates KaoMisconfiguredError", async () => {
    mockWithFreshAuth.mockRejectedValueOnce(new KaoMisconfiguredError("KAO_TOKEN bad"));
    await expect(getEmailById("msg-1")).rejects.toBeInstanceOf(KaoMisconfiguredError);
  });

  it("propagates KaoUnreachableError (downed Kao is operator-visible, not silent null)", async () => {
    mockWithFreshAuth.mockRejectedValueOnce(new KaoUnreachableError("connect ECONNREFUSED"));
    await expect(getEmailById("msg-1")).rejects.toBeInstanceOf(KaoUnreachableError);
  });

  it("resolves null on a generic per-message Gmail error (pre-existing contract)", async () => {
    mockWithFreshAuth.mockRejectedValueOnce(new Error("Gmail API: 503"));
    await expect(getEmailById("msg-1")).resolves.toBeNull();
  });

  it("resolves null on a 404-style error", async () => {
    const err = Object.assign(new Error("Not Found"), { status: 404 });
    mockWithFreshAuth.mockRejectedValueOnce(err);
    await expect(getEmailById("msg-missing")).resolves.toBeNull();
  });
});

describe("gmail.getOwnerAddress", () => {
  // One test for the whole lifecycle — failure → success → cache — because the
  // cache is module-level, so separate its would couple to execution order.
  it("returns null on failure (uncached), then lowercases and caches the first success", async () => {
    mockWithFreshAuth.mockRejectedValueOnce(new Error("kao down"));
    expect(await getOwnerAddress()).toBeNull();

    mockWithFreshAuth.mockResolvedValueOnce("Owner@Example.com");
    expect(await getOwnerAddress()).toBe("owner@example.com");

    // Cached: no further withFreshAuth round-trips.
    const callsAfterSuccess = mockWithFreshAuth.mock.calls.length;
    expect(await getOwnerAddress()).toBe("owner@example.com");
    expect(mockWithFreshAuth.mock.calls.length).toBe(callsAfterSuccess);
  });
});
