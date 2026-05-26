import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  OAuthError,
  clearAccessTokenCache,
  fetchGrantStatus,
  getAccessToken,
} from "../src/lib/kao-client.js";

const validEnv = {
  MONGODB_URI: "mongodb://127.0.0.1:27017/kizuna",
  USER_EMAILS: "me@example.com",
  KAO_URL: "https://api.kao.localhost",
  KAO_TOKEN: "bearer-xyz-16chars-or-more",
};

function configWith(overrides: Record<string, string> = {}) {
  return loadConfig({ ...validEnv, ...overrides });
}

function vendedBody(token: string, ttlMs = 60 * 60 * 1000) {
  return {
    accessToken: token,
    expiresAt: Date.now() + ttlMs,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  clearAccessTokenCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getAccessToken", () => {
  it("vends a token via Kao and caches it for the window", async () => {
    const config = configWith();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, vendedBody("ya29.fresh")));

    const t1 = await getAccessToken(config);
    expect(t1).toBe("ya29.fresh");

    // Second call inside the cache window should NOT hit fetch.
    const t2 = await getAccessToken(config);
    expect(t2).toBe("ya29.fresh");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toBe("https://api.kao.localhost/grants/kizuna/token");
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer bearer-xyz-16chars-or-more",
    );
  });

  it("force: true bypasses the local cache and adds ?force=1", async () => {
    const config = configWith();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, vendedBody("ya29.first")))
      .mockResolvedValueOnce(jsonResponse(200, vendedBody("ya29.second")));

    expect(await getAccessToken(config)).toBe("ya29.first");
    expect(await getAccessToken(config, { force: true })).toBe("ya29.second");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]![0]).toBe(
      "https://api.kao.localhost/grants/kizuna/token?force=1",
    );
  });

  it("translates Kao 409 no_grant → OAuthError(no_grant)", async () => {
    const config = configWith();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(409, { error: { details: { code: "no_grant" } } }),
    );
    try {
      await getAccessToken(config);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).code).toBe("no_grant");
    }
  });

  it("translates Kao 409 invalid_grant → OAuthError(invalid_grant)", async () => {
    const config = configWith();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(409, { error: { details: { code: "invalid_grant" } } }),
    );
    await expect(getAccessToken(config)).rejects.toMatchObject({
      code: "invalid_grant",
    });
  });

  it("translates Kao 409 decrypt_failed → OAuthError(invalid_grant)", async () => {
    const config = configWith();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(409, { error: { details: { code: "decrypt_failed" } } }),
    );
    // decrypt_failed also needs re-consent so it maps to invalid_grant for
    // the worker's pause path (which is what we want operationally).
    await expect(getAccessToken(config)).rejects.toMatchObject({
      code: "invalid_grant",
    });
  });

  it("translates Kao 401 (bad bearer) → OAuthError(refresh_failed)", async () => {
    const config = configWith();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(401, { error: { message: "bad bearer" } }),
    );
    await expect(getAccessToken(config)).rejects.toMatchObject({
      code: "refresh_failed",
    });
  });

  it("translates Kao 404 (grant unknown) → OAuthError(no_grant)", async () => {
    // 404 means Kao has no 'kizuna' entry in GRANT_NAMES. Semantically
    // "operator hasn't registered the grant yet" — should idle cleanly, not
    // inflate errorCount via refresh_failed.
    const config = configWith();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(404, { error: { message: "unknown grant" } }),
    );
    try {
      await getAccessToken(config);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).code).toBe("no_grant");
    }
  });

  it("does not crash if Kao returns a literal JSON null body on 409", async () => {
    // Regression: `body.error?.details?.code` would TypeError on a null body
    // because optional chaining doesn't short-circuit the receiver.
    const config = configWith();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("null", {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      await getAccessToken(config);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthError);
      // Unknown detailsCode → defaults to no_grant.
      expect((err as OAuthError).code).toBe("no_grant");
    }
  });

  it("translates a network failure → OAuthError(refresh_failed)", async () => {
    const config = configWith();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(getAccessToken(config)).rejects.toMatchObject({
      code: "refresh_failed",
    });
  });

  it("treats implausible expiresAt as unreachable (does not cache)", async () => {
    const config = configWith();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      // expiresAt in the past — would pin a dead token if cached.
      .mockResolvedValueOnce(
        jsonResponse(200, { accessToken: "ya29.x", expiresAt: Date.now() - 1000 }),
      )
      .mockResolvedValueOnce(jsonResponse(200, vendedBody("ya29.good")));

    await expect(getAccessToken(config)).rejects.toMatchObject({
      code: "refresh_failed",
    });
    expect(await getAccessToken(config)).toBe("ya29.good");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws OAuthError(refresh_failed) when KAO is unconfigured", async () => {
    const config = loadConfig({
      MONGODB_URI: "mongodb://127.0.0.1:27017/kizuna",
      USER_EMAILS: "me@example.com",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(getAccessToken(config)).rejects.toMatchObject({
      code: "refresh_failed",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("clearAccessTokenCache forces the next call to re-vend", async () => {
    const config = configWith();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, vendedBody("ya29.a")))
      .mockResolvedValueOnce(jsonResponse(200, vendedBody("ya29.b")));

    expect(await getAccessToken(config)).toBe("ya29.a");
    clearAccessTokenCache();
    expect(await getAccessToken(config)).toBe("ya29.b");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("fetchGrantStatus", () => {
  it("returns { granted: false } when Kao is unconfigured", async () => {
    const config = loadConfig({
      MONGODB_URI: "mongodb://127.0.0.1:27017/kizuna",
      USER_EMAILS: "me@example.com",
    });
    const status = await fetchGrantStatus(config);
    expect(status).toEqual({ granted: false });
  });

  it("reshapes a granted Kao response into the OAuthStatus envelope", async () => {
    const config = configWith();
    const grantedAt = "2026-04-01T12:00:00.000Z";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(200, {
        name: "kizuna",
        granted: true,
        scopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/calendar.readonly",
        ],
        grantedAt,
        revokedAt: null,
      }),
    );
    const status = await fetchGrantStatus(config);
    expect(status).toEqual({
      granted: true,
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/calendar.readonly",
      ],
      grantedAt,
    });
  });

  it("collapses an ungranted Kao row to { granted: false }", async () => {
    const config = configWith();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(200, {
        name: "kizuna",
        granted: false,
        scopes: [],
        grantedAt: null,
        revokedAt: null,
      }),
    );
    expect(await fetchGrantStatus(config)).toEqual({ granted: false });
  });

  it("falls back to { granted: false } on Kao failures", async () => {
    const config = configWith();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await fetchGrantStatus(config)).toEqual({ granted: false });
  });
});
