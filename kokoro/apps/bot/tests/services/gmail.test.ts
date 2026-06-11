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
// Google" and assert how gmail.ts's catch routes them. For the
// getOwnerAddress tests the mock EXECUTES the callback with a fake auth so
// the token-keyed cache is exercised; googleapis is mocked so the callback's
// getProfile call hits a controllable stub.
const { mockWithFreshAuth, mockGetProfile } = vi.hoisted(() => ({
  mockWithFreshAuth: vi.fn(),
  mockGetProfile: vi.fn(),
}));
vi.mock("../../src/services/google-auth", () => ({
  withFreshAuth: mockWithFreshAuth,
}));
vi.mock("googleapis", () => ({
  google: {
    gmail: vi.fn(() => ({ users: { getProfile: mockGetProfile } })),
  },
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
  // One test for the whole lifecycle — failure → success → cache hit →
  // token-rotation invalidation — because the cache is module-level, so
  // separate `it`s would couple to execution order.
  it("caches per access token and re-fetches when the token changes (re-consent safety)", async () => {
    const runWithToken = (token: string) =>
      mockWithFreshAuth.mockImplementation((op: (auth: unknown) => Promise<unknown>) =>
        op({ credentials: { access_token: token } }),
      );

    // Failure → null, and nothing cached.
    mockWithFreshAuth.mockRejectedValueOnce(new Error("kao down"));
    expect(await getOwnerAddress()).toBeNull();

    // First success: lowercased, one profile fetch.
    runWithToken("tok-1");
    mockGetProfile.mockResolvedValue({ data: { emailAddress: "Owner@Example.com" } });
    expect(await getOwnerAddress()).toBe("owner@example.com");
    expect(mockGetProfile).toHaveBeenCalledTimes(1);

    // Same token → cache hit, no second profile fetch.
    expect(await getOwnerAddress()).toBe("owner@example.com");
    expect(mockGetProfile).toHaveBeenCalledTimes(1);

    // New token (hourly rotation OR a Kao re-consent to a different Google
    // account) → cache miss, profile re-fetched, new address wins. This is
    // the case that must never serve the stale "self" address.
    runWithToken("tok-2");
    mockGetProfile.mockResolvedValue({ data: { emailAddress: "other@example.com" } });
    expect(await getOwnerAddress()).toBe("other@example.com");
    expect(mockGetProfile).toHaveBeenCalledTimes(2);
  });
});
