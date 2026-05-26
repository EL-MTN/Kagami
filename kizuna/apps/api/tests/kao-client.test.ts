import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { clearAccessTokenCache, getAccessToken, OAuthError } from "../src/lib/kao-client.js";

// Stub globalThis.fetch directly rather than vi.mock-ing
// `@kagami/logger/traced-fetch`. tracedFetch just calls global fetch when no
// trace context is active (the case in these tests), and stubbing the global
// is robust against the workspace's "built package" module-resolution layout.
const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
  clearAccessTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessTokenCache();
});

// Minimal Config — kao-client only reads KAO_URL and KAO_TOKEN.
const config = {
  KAO_URL: "https://api.kao.test",
  KAO_TOKEN: "test-bearer-aaaaaaaaaaaaaaaa",
} as unknown as Config;

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function jsonError(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("kao-client", () => {
  it("vends an access token and caches it within the expiry window", async () => {
    const future = Date.now() + 10 * 60_000;
    mockFetch.mockResolvedValueOnce(ok({ accessToken: "ya29.t1", expiresAt: future }));

    const a = await getAccessToken(config);
    const b = await getAccessToken(config);

    expect(a).toBe("ya29.t1");
    expect(b).toBe("ya29.t1");
    // Second call must hit the cache — no second HTTP round-trip.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.kao.test/grants/kizuna/token",
      expect.objectContaining({
        headers: { Authorization: "Bearer test-bearer-aaaaaaaaaaaaaaaa" },
      }),
    );
  });

  it("strips a trailing slash from KAO_URL when building the vend URL", async () => {
    mockFetch.mockResolvedValueOnce(ok({ accessToken: "ya29.t", expiresAt: Date.now() + 60_000 }));
    await getAccessToken({ ...config, KAO_URL: "https://api.kao.test/" });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.kao.test/grants/kizuna/token",
      expect.any(Object),
    );
  });

  it("refetches when the cached token is within the 30s expiry buffer", async () => {
    const nearlyExpired = Date.now() + 1_000;
    mockFetch
      .mockResolvedValueOnce(ok({ accessToken: "ya29.t1", expiresAt: nearlyExpired }))
      .mockResolvedValueOnce(ok({ accessToken: "ya29.t2", expiresAt: Date.now() + 60_000 }));

    await getAccessToken(config);
    const second = await getAccessToken(config);

    expect(second).toBe("ya29.t2");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("maps Kao 409 no_grant to OAuthError(no_grant) with a re-consent hint", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonError(409, { error: { code: "conflict", details: { code: "no_grant" } } }),
    );

    const err = await getAccessToken(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("no_grant");
    expect((err as OAuthError).message).toContain("/oauth/kizuna/start");
  });

  it("maps Kao 409 invalid_grant to OAuthError(invalid_grant) so the worker pauses", async () => {
    // The ingest workers branch on .code === "invalid_grant" to set
    // SyncState.pausedAt. Preserving this taxonomy is the whole reason
    // kao-client re-exports OAuthError instead of inventing a new class.
    mockFetch.mockResolvedValueOnce(
      jsonError(409, { error: { code: "conflict", details: { code: "invalid_grant" } } }),
    );

    const err = await getAccessToken(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("invalid_grant");
    expect((err as OAuthError).message).toContain("/oauth/kizuna/start");
  });

  it("collapses Kao 409 decrypt_failed into invalid_grant (re-consent fixes it)", async () => {
    // Kao distinguishes decrypt_failed (key rotation / corrupt ciphertext)
    // from invalid_grant — both are fixed by re-consenting at Kao, so we
    // collapse to invalid_grant here for the same operator action.
    mockFetch.mockResolvedValueOnce(
      jsonError(409, { error: { code: "conflict", details: { code: "decrypt_failed" } } }),
    );

    const err = await getAccessToken(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("invalid_grant");
    expect((err as OAuthError).message).toContain("decrypt_failed");
  });

  it("treats Kao 401 (bad bearer) as refresh_failed — operator config error", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 401 }));
    const err = await getAccessToken(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("refresh_failed");
    expect((err as OAuthError).message).toContain("KAO_TOKEN");
  });

  it("treats Kao 404 (grant not registered) as refresh_failed with a registry hint", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 404 }));
    const err = await getAccessToken(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("refresh_failed");
    expect((err as OAuthError).message).toContain("grant-registry");
  });

  it("treats Kao 502 (upstream Google) as refresh_failed (transient)", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 502 }));
    const err = await getAccessToken(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("refresh_failed");
  });

  it("surfaces a missing KAO_TOKEN as refresh_failed without making an HTTP call", async () => {
    const err = await getAccessToken({ ...config, KAO_TOKEN: undefined }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("refresh_failed");
    expect((err as OAuthError).message).toContain("KAO_TOKEN");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not cache an error response", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonError(409, { error: { code: "conflict", details: { code: "no_grant" } } }),
      )
      .mockResolvedValueOnce(ok({ accessToken: "ya29.recovered", expiresAt: Date.now() + 60_000 }));

    await expect(getAccessToken(config)).rejects.toBeInstanceOf(OAuthError);
    const recovered = await getAccessToken(config);
    expect(recovered).toBe("ya29.recovered");
  });

  it("dedupes concurrent in-flight requests on a cold cache", async () => {
    // A scheduler tick runs Gmail + Calendar back-to-back; both may call
    // getAccessToken before either resolves. They must share one fetch.
    let resolveFetch!: (r: Response) => void;
    mockFetch.mockReturnValueOnce(new Promise<Response>((r) => (resolveFetch = r)));

    const future = Date.now() + 10 * 60_000;
    const a = getAccessToken(config);
    const b = getAccessToken(config);
    resolveFetch(ok({ accessToken: "ya29.shared", expiresAt: future }));

    const [resA, resB] = await Promise.all([a, b]);
    expect(resA).toBe("ya29.shared");
    expect(resB).toBe("ya29.shared");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed JSON in the success body as refresh_failed", async () => {
    mockFetch.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    const err = await getAccessToken(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("refresh_failed");
  });

  it("rejects NaN / past / absurdly-far-future expiresAt (cache-poison defense)", async () => {
    for (const expiresAt of [NaN, Date.now() - 60_000, Date.now() + 10 * 365 * 24 * 3600 * 1000]) {
      mockFetch.mockResolvedValueOnce(ok({ accessToken: "ya29.tok", expiresAt }));
      const err = await getAccessToken(config).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).code).toBe("refresh_failed");
      clearAccessTokenCache();
    }
  });

  it("rejects an empty accessToken as refresh_failed", async () => {
    mockFetch.mockResolvedValueOnce(ok({ accessToken: "", expiresAt: Date.now() + 60_000 }));
    const err = await getAccessToken(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("refresh_failed");
  });

  it("rejects a literal-null JSON body as refresh_failed", async () => {
    // `res.json()` resolves null for a JSON `null` body — would otherwise
    // throw TypeError on the subsequent property access, outside taxonomy.
    mockFetch.mockResolvedValueOnce(new Response("null", { status: 200 }));
    const err = await getAccessToken(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("refresh_failed");
  });

  it("surfaces a fetch rejection (timeout / network) as refresh_failed", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const err = await getAccessToken(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("refresh_failed");
    expect((err as OAuthError).message).toContain("ECONNREFUSED");
  });

  it("force=true sends ?force=1 to Kao and bypasses the local cache", async () => {
    const future = Date.now() + 10 * 60_000;
    mockFetch.mockResolvedValueOnce(ok({ accessToken: "ya29.cached", expiresAt: future }));
    await getAccessToken(config);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Without force: cache hit, no fetch.
    await getAccessToken(config);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // With force: skip both caches, hit Kao with ?force=1.
    mockFetch.mockResolvedValueOnce(ok({ accessToken: "ya29.forced", expiresAt: future }));
    const forced = await getAccessToken(config, { force: true });
    expect(forced).toBe("ya29.forced");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenLastCalledWith(
      "https://api.kao.test/grants/kizuna/token?force=1",
      expect.any(Object),
    );
  });

  it("a stale non-force inflight does NOT overwrite a force-refreshed cache value", async () => {
    // Scenario: non-force call A is in flight (slow). Force call B runs to
    // completion against a different mock response. Then A's slow response
    // finally resolves — it must NOT clobber B's fresh value in cache.
    let resolveStale!: (r: Response) => void;
    mockFetch.mockReturnValueOnce(new Promise<Response>((r) => (resolveStale = r)));

    const future = Date.now() + 10 * 60_000;
    const stale = getAccessToken(config); // non-force, occupies inflight

    mockFetch.mockResolvedValueOnce(ok({ accessToken: "ya29.forced", expiresAt: future }));
    const forced = await getAccessToken(config, { force: true });
    expect(forced).toBe("ya29.forced");

    // Now let the stale inflight resolve. Race-safety guard (`inflight === p`)
    // must prevent it from writing to cache or nulling out anything.
    resolveStale(ok({ accessToken: "ya29.stale", expiresAt: future }));
    await stale;

    const final = await getAccessToken(config);
    expect(final).toBe("ya29.forced");
  });

  it("clearAccessTokenCache also clears inflight so a subsequent fetch is fresh", async () => {
    let resolveStale!: (r: Response) => void;
    mockFetch.mockReturnValueOnce(new Promise<Response>((r) => (resolveStale = r)));
    const stale = getAccessToken(config);

    // While inflight, clear. A subsequent caller must NOT piggyback the stale
    // inflight — it must start a brand-new fetch.
    clearAccessTokenCache();

    const future = Date.now() + 10 * 60_000;
    mockFetch.mockResolvedValueOnce(ok({ accessToken: "ya29.fresh", expiresAt: future }));
    const freshResult = await getAccessToken(config);
    expect(freshResult).toBe("ya29.fresh");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    resolveStale(ok({ accessToken: "ya29.stale", expiresAt: future }));
    await stale.catch(() => undefined);
  });
});
