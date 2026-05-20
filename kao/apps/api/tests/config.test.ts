import { describe, expect, it } from "vitest";
import { callbackUrl, loadConfig } from "../src/config.js";

const KEY = Buffer.alloc(32, 1).toString("base64");

function baseEnv(): NodeJS.ProcessEnv {
  return {
    MONGODB_URI: "mongodb://127.0.0.1:27017/kao",
    GOOGLE_OAUTH_CLIENT_ID: "cid",
    GOOGLE_OAUTH_CLIENT_SECRET: "csecret",
    KAO_ENCRYPTION_KEY: KEY,
    KAO_TOKEN: "x".repeat(32),
  };
}

describe("config", () => {
  it("accepts a valid env and applies defaults", () => {
    const c = loadConfig(baseEnv());
    expect(c.KAO_DB_NAME).toBe("kao");
    expect(c.KAO_PUBLIC_URL).toBe("https://api.kao.localhost");
    expect(c.KAO_DASHBOARD_URL).toBe("https://kao.localhost");
    expect(c.PORT).toBe(4040);
  });

  it("accepts an explicit KAO_DASHBOARD_URL override", () => {
    const c = loadConfig({ ...baseEnv(), KAO_DASHBOARD_URL: "https://kao.example.com" });
    expect(c.KAO_DASHBOARD_URL).toBe("https://kao.example.com");
  });

  it("rejects a non-URL KAO_DASHBOARD_URL", () => {
    expect(() => loadConfig({ ...baseEnv(), KAO_DASHBOARD_URL: "not-a-url" })).toThrow(
      /KAO_DASHBOARD_URL/,
    );
  });

  it("rejects a javascript: scheme on KAO_DASHBOARD_URL", () => {
    // KAO_DASHBOARD_URL is rendered into anchor hrefs in the inline OAuth
    // success page — a non-http(s) scheme would be a clickable XSS vector.
    expect(() => loadConfig({ ...baseEnv(), KAO_DASHBOARD_URL: "javascript:alert(1)" })).toThrow(
      /KAO_DASHBOARD_URL/,
    );
  });

  it("rejects a javascript: scheme on KAO_PUBLIC_URL", () => {
    expect(() => loadConfig({ ...baseEnv(), KAO_PUBLIC_URL: "javascript:alert(1)" })).toThrow(
      /KAO_PUBLIC_URL/,
    );
  });

  it("rejects a KAO_DASHBOARD_URL with a path", () => {
    // The dashboard URL is composed as `${KAO_DASHBOARD_URL}/grants/:n` in
    // the inline OAuth success page — a path/query/fragment here produces a
    // malformed href. Reject at validation rather than silently rendering it.
    expect(() =>
      loadConfig({ ...baseEnv(), KAO_DASHBOARD_URL: "https://kao.localhost/foo" }),
    ).toThrow(/KAO_DASHBOARD_URL/);
  });

  it("rejects a KAO_DASHBOARD_URL with a query string", () => {
    expect(() =>
      loadConfig({ ...baseEnv(), KAO_DASHBOARD_URL: "https://kao.localhost?x=1" }),
    ).toThrow(/KAO_DASHBOARD_URL/);
  });

  it("accepts a KAO_DASHBOARD_URL with a bare trailing slash", () => {
    // Trailing slash is stripped at use-site (oauth.ts) — must still pass
    // the origin-only validation.
    const c = loadConfig({ ...baseEnv(), KAO_DASHBOARD_URL: "https://kao.localhost/" });
    expect(c.KAO_DASHBOARD_URL).toBe("https://kao.localhost/");
  });

  it("rejects a missing Google client id", () => {
    const env = baseEnv();
    delete env.GOOGLE_OAUTH_CLIENT_ID;
    expect(() => loadConfig(env)).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
  });

  it("rejects an encryption key that is not 32 bytes", () => {
    expect(() =>
      loadConfig({ ...baseEnv(), KAO_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }),
    ).toThrow(/KAO_ENCRYPTION_KEY/);
  });

  it("rejects a too-short bearer", () => {
    expect(() => loadConfig({ ...baseEnv(), KAO_TOKEN: "short" })).toThrow(/KAO_TOKEN/);
  });

  it("rejects a non-mongodb URI", () => {
    expect(() => loadConfig({ ...baseEnv(), MONGODB_URI: "http://nope" })).toThrow(/MONGODB_URI/);
  });

  it("derives the single callback URL and strips a trailing slash", () => {
    const c = loadConfig({ ...baseEnv(), KAO_PUBLIC_URL: "https://api.kao.localhost/" });
    expect(callbackUrl(c)).toBe("https://api.kao.localhost/oauth/callback");
  });
});
