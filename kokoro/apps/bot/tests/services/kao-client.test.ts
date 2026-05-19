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
  KaoUnreachableError,
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

  it("maps Kao 409 decrypt_failed distinctly (key-rotation / corrupt ciphertext)", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonError(409, { error: { code: "conflict", details: { code: "decrypt_failed" } } }),
    );

    const err = await getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaoNoGrantError);
    expect((err as KaoNoGrantError).code).toBe("decrypt_failed");
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

  it("dedupes concurrent in-flight requests on a cold cache", async () => {
    // A single LLM turn may hit gmail + calendar back-to-back; both call
    // getAccessToken before either resolves. They must share one fetch.
    let resolveFetch!: (r: Response) => void;
    mockFetch.mockReturnValueOnce(new Promise<Response>((r) => (resolveFetch = r)));

    const future = Date.now() + 10 * 60_000;
    const a = getAccessToken();
    const b = getAccessToken();
    resolveFetch(ok({ accessToken: "ya29.shared", expiresAt: future }));

    const [resA, resB] = await Promise.all([a, b]);
    expect(resA.accessToken).toBe("ya29.shared");
    expect(resB.accessToken).toBe("ya29.shared");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed JSON in the success body as KaoUnreachableError", async () => {
    mockFetch.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    const err = await getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaoUnreachableError);
  });

  it("rejects NaN expiresAt as KaoUnreachableError (cache-poison defense)", async () => {
    mockFetch.mockResolvedValueOnce(ok({ accessToken: "ya29.tok", expiresAt: NaN }));
    const err = await getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaoUnreachableError);
  });

  it("rejects an expiresAt that is already in the past", async () => {
    mockFetch.mockResolvedValueOnce(
      ok({ accessToken: "ya29.tok", expiresAt: Date.now() - 60_000 }),
    );
    const err = await getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaoUnreachableError);
  });

  it("rejects an absurdly-far-future expiresAt (sanity bound)", async () => {
    // 10 years out — would pin a dead token until process restart.
    mockFetch.mockResolvedValueOnce(
      ok({ accessToken: "ya29.tok", expiresAt: Date.now() + 10 * 365 * 24 * 3600 * 1000 }),
    );
    const err = await getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaoUnreachableError);
  });

  it("rejects an empty accessToken as KaoUnreachableError", async () => {
    mockFetch.mockResolvedValueOnce(ok({ accessToken: "", expiresAt: Date.now() + 60_000 }));
    const err = await getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaoUnreachableError);
  });

  it("rejects a literal-null JSON body as KaoUnreachableError", async () => {
    // `res.json()` resolves null for a JSON `null` body — would otherwise
    // throw TypeError on the subsequent property access, outside taxonomy.
    mockFetch.mockResolvedValueOnce(new Response("null", { status: 200 }));
    const err = await getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaoUnreachableError);
  });

  it("force=true sends ?force=1 to Kao and bypasses the local cache", async () => {
    // Prime the cache.
    const future = Date.now() + 10 * 60_000;
    mockFetch.mockResolvedValueOnce(ok({ accessToken: "ya29.cached", expiresAt: future }));
    await getAccessToken();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Without force: cache hit, no fetch.
    await getAccessToken();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // With force: skip cache, hit Kao with ?force=1.
    mockFetch.mockResolvedValueOnce(ok({ accessToken: "ya29.forced", expiresAt: future }));
    const forced = await getAccessToken({ force: true });
    expect(forced.accessToken).toBe("ya29.forced");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenLastCalledWith(
      "https://api.kao.test/grants/kokoro/token?force=1",
      expect.any(Object),
    );
  });

  it("a stale non-force inflight does NOT overwrite a force-refreshed cache value", async () => {
    // Scenario: non-force call A is in flight (slow). Force call B runs to
    // completion against a different mock response. Then A's slow response
    // finally resolves — it must NOT clobber B's fresh value in cache, and
    // it must not null out the (now-released) inflight slot in a way that
    // breaks a third caller's dedup.
    let resolveStale!: (r: Response) => void;
    mockFetch.mockReturnValueOnce(new Promise<Response>((r) => (resolveStale = r)));

    const future = Date.now() + 10 * 60_000;
    const stale = getAccessToken(); // non-force, joins the inflight slot

    // Force call evicts inflight, runs to completion immediately.
    mockFetch.mockResolvedValueOnce(ok({ accessToken: "ya29.forced", expiresAt: future }));
    const forced = await getAccessToken({ force: true });
    expect(forced.accessToken).toBe("ya29.forced");

    // Cache hit after force returns the forced value.
    const afterForce = await getAccessToken();
    expect(afterForce.accessToken).toBe("ya29.forced");

    // Now let the stale inflight resolve. Its `.finally`-equivalent logic
    // must be gated on `inflight === p`; since `inflight` was replaced by
    // the force, the stale's resolution must NOT write to cache.
    resolveStale(ok({ accessToken: "ya29.stale", expiresAt: future }));
    await stale; // stale gets its own value back — but that's local to its caller

    // Cache still holds the forced value.
    const final = await getAccessToken();
    expect(final.accessToken).toBe("ya29.forced");
  });

  it("clearAccessTokenCache also clears inflight so a subsequent fetch is fresh", async () => {
    // Start an inflight that will resolve later.
    let resolveStale!: (r: Response) => void;
    mockFetch.mockReturnValueOnce(new Promise<Response>((r) => (resolveStale = r)));
    const stale = getAccessToken();

    // While inflight, clear the cache. A subsequent caller must NOT piggyback
    // the stale inflight — it must start a brand-new fetch.
    clearAccessTokenCache();

    const future = Date.now() + 10 * 60_000;
    mockFetch.mockResolvedValueOnce(ok({ accessToken: "ya29.fresh", expiresAt: future }));
    const freshResult = await getAccessToken();
    expect(freshResult.accessToken).toBe("ya29.fresh");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Let the stale inflight resolve so vitest doesn't complain about unsettled promises.
    resolveStale(ok({ accessToken: "ya29.stale", expiresAt: future }));
    await stale.catch(() => undefined);
  });
});

describe("kao-client — misconfiguration", () => {
  // This block re-mocks @kokoro/shared with KAO_URL/KAO_TOKEN undefined and
  // re-imports kao-client. Restore the file-level mock state in afterEach so
  // that adding any subsequent test below this block doesn't silently
  // inherit the misconfig mock and produce confusing failures.
  afterEach(() => {
    vi.doUnmock("@kokoro/shared");
    vi.resetModules();
  });

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
