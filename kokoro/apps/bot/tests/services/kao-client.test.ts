import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @kokoro/shared so we can control config + intercept tracedFetch.
// Hoist the fetch spy so the mock factory can capture it (vi.mock factories
// can only close over hoisted values).
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock("@kokoro/shared", async (orig) => ({
  ...(await orig()),
  config: {
    KAO_URL: "https://api.kao.test",
    KAO_TOKEN: "test-bearer-aaaaaaaaaaaaaaaa",
  },
  tracedFetch: mockFetch,
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

import {
  clearAccessTokenCache,
  getAccessToken,
  KaoMisconfiguredError,
  KaoNoGrantError,
} from "../../src/services/kao-client";

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function jsonError(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  mockFetch.mockReset();
  clearAccessTokenCache();
});

afterEach(() => {
  clearAccessTokenCache();
});

describe("kao-client", () => {
  it("vends an access token and caches it within the expiry window", async () => {
    const future = Date.now() + 10 * 60_000;
    mockFetch.mockResolvedValueOnce(ok({ accessToken: "ya29.t1", expiresAt: future }));

    const a = await getAccessToken();
    const b = await getAccessToken();

    expect(a.accessToken).toBe("ya29.t1");
    expect(b.accessToken).toBe("ya29.t1");
    // Second call must hit the cache — no second HTTP round-trip.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.kao.test/grants/kokoro/token",
      expect.objectContaining({
        headers: { Authorization: "Bearer test-bearer-aaaaaaaaaaaaaaaa" },
      }),
    );
  });

  it("refetches when the cached token is within the 30s expiry buffer", async () => {
    const nearlyExpired = Date.now() + 1_000;
    mockFetch
      .mockResolvedValueOnce(ok({ accessToken: "ya29.t1", expiresAt: nearlyExpired }))
      .mockResolvedValueOnce(ok({ accessToken: "ya29.t2", expiresAt: Date.now() + 60_000 }));

    await getAccessToken();
    const second = await getAccessToken();

    expect(second.accessToken).toBe("ya29.t2");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("maps Kao 409 no_grant to KaoNoGrantError with a re-consent hint", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonError(409, { error: { code: "conflict", details: { code: "no_grant" } } }),
    );

    const err = await getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaoNoGrantError);
    expect((err as KaoNoGrantError).code).toBe("no_grant");
    expect((err as KaoNoGrantError).message).toContain("/oauth/kokoro/start");
  });

  it("maps Kao 409 invalid_grant distinctly so callers can surface re-consent", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonError(409, { error: { code: "conflict", details: { code: "invalid_grant" } } }),
    );

    const err = await getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaoNoGrantError);
    expect((err as KaoNoGrantError).code).toBe("invalid_grant");
  });

  it("treats Kao 401 as a config error (bearer wrong), not transient", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 401 }));
    const err = await getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaoMisconfiguredError);
  });

  it("does not cache an error response", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonError(409, { error: { code: "conflict", details: { code: "no_grant" } } }),
      )
      .mockResolvedValueOnce(ok({ accessToken: "ya29.recovered", expiresAt: Date.now() + 60_000 }));

    await expect(getAccessToken()).rejects.toBeInstanceOf(KaoNoGrantError);
    const recovered = await getAccessToken();
    expect(recovered.accessToken).toBe("ya29.recovered");
  });
});

describe("kao-client — misconfiguration", () => {
  it("throws KaoMisconfiguredError when KAO_URL is unset", async () => {
    vi.resetModules();
    vi.doMock("@kokoro/shared", async (orig) => ({
      ...(await orig()),
      config: { KAO_URL: undefined, KAO_TOKEN: undefined },
      tracedFetch: mockFetch,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
      },
    }));
    const mod = await import("../../src/services/kao-client");
    mod.clearAccessTokenCache();
    await expect(mod.getAccessToken()).rejects.toBeInstanceOf(mod.KaoMisconfiguredError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
