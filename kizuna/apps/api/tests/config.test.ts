import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const validEnv = {
  MONGO_URI: "mongodb://127.0.0.1:27017/kizuna",
  USER_EMAILS: "me@example.com,you@example.com",
};

describe("loadConfig", () => {
  it("parses a valid env and applies defaults", () => {
    const c = loadConfig(validEnv);
    expect(c.USER_EMAILS).toEqual(["me@example.com", "you@example.com"]);
    expect(c.PORT).toBe(3000);
    expect(c.KIZUNA_HOST).toBe("127.0.0.1");
    expect(c.NEWSLETTER_DOMAIN_BLOCKLIST).toEqual([]);
  });

  it("lowercases USER_EMAILS", () => {
    const c = loadConfig({ ...validEnv, USER_EMAILS: "Me@Example.com" });
    expect(c.USER_EMAILS).toEqual(["me@example.com"]);
  });

  it("parses NEWSLETTER_DOMAIN_BLOCKLIST as a lowercased csv", () => {
    const c = loadConfig({
      ...validEnv,
      NEWSLETTER_DOMAIN_BLOCKLIST: "Mail.Beehiiv.com, news.example.com",
    });
    expect(c.NEWSLETTER_DOMAIN_BLOCKLIST).toEqual(["mail.beehiiv.com", "news.example.com"]);
  });

  it("coerces PORT", () => {
    const c = loadConfig({ ...validEnv, PORT: "4000" });
    expect(c.PORT).toBe(4000);
  });

  it("allows overriding the API host", () => {
    const c = loadConfig({ ...validEnv, KIZUNA_HOST: "0.0.0.0" });
    expect(c.KIZUNA_HOST).toBe("0.0.0.0");
  });

  it("treats blank optional strings as unset", () => {
    const c = loadConfig({
      ...validEnv,
      GOOGLE_OAUTH_CLIENT_ID: "",
      GOOGLE_OAUTH_CLIENT_SECRET: "   ",
      GOOGLE_OAUTH_REDIRECT_URI: "",
      KIZUNA_OAUTH_ENCRYPTION_KEY: "",
      KIZUNA_HOST: "",
    });
    expect(c.GOOGLE_OAUTH_CLIENT_ID).toBeUndefined();
    expect(c.GOOGLE_OAUTH_CLIENT_SECRET).toBeUndefined();
    expect(c.GOOGLE_OAUTH_REDIRECT_URI).toBeUndefined();
    expect(c.KIZUNA_OAUTH_ENCRYPTION_KEY).toBeUndefined();
    expect(c.KIZUNA_HOST).toBe("127.0.0.1");
  });

  it("trims optional string values", () => {
    const key = Buffer.alloc(32, 1).toString("base64");
    const c = loadConfig({
      ...validEnv,
      GOOGLE_OAUTH_CLIENT_ID: "  client-id  ",
      GOOGLE_OAUTH_CLIENT_SECRET: "  client-secret  ",
      GOOGLE_OAUTH_REDIRECT_URI: "  https://api.kizuna.localhost/oauth/google/callback  ",
      KIZUNA_OAUTH_ENCRYPTION_KEY: `  ${key}  `,
    });
    expect(c.GOOGLE_OAUTH_CLIENT_ID).toBe("client-id");
    expect(c.GOOGLE_OAUTH_CLIENT_SECRET).toBe("client-secret");
    expect(c.GOOGLE_OAUTH_REDIRECT_URI).toBe("https://api.kizuna.localhost/oauth/google/callback");
    expect(c.KIZUNA_OAUTH_ENCRYPTION_KEY).toBe(key);
  });

  it("rejects a non-mongodb URI", () => {
    expect(() => loadConfig({ ...validEnv, MONGO_URI: "http://nope" })).toThrow();
  });

  it("rejects malformed USER_EMAILS", () => {
    expect(() => loadConfig({ ...validEnv, USER_EMAILS: "not-an-email" })).toThrow();
  });

  it("rejects malformed non-empty optional values", () => {
    expect(() =>
      loadConfig({
        ...validEnv,
        GOOGLE_OAUTH_REDIRECT_URI: "not-a-url",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...validEnv,
        KIZUNA_OAUTH_ENCRYPTION_KEY: "not-32-bytes",
      }),
    ).toThrow();
  });
});
