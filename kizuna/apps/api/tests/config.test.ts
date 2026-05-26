import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const validEnv = {
  MONGODB_URI: "mongodb://127.0.0.1:27017/kizuna",
  USER_EMAILS: "me@example.com,you@example.com",
};

describe("loadConfig", () => {
  it("parses a valid env and applies defaults", () => {
    const c = loadConfig(validEnv);
    expect(c.USER_EMAILS).toEqual(["me@example.com", "you@example.com"]);
    expect(c.PORT).toBe(3000);
    expect(c.KIZUNA_HOST).toBe("127.0.0.1");
    expect(c.KAO_URL).toBe("https://api.kao.localhost");
    expect(c.KAO_TOKEN).toBeUndefined();
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

  it("treats blank optional strings as unset (falling back to defaults)", () => {
    const c = loadConfig({
      ...validEnv,
      KAO_URL: "",
      KAO_TOKEN: "   ",
      KIZUNA_HOST: "",
    });
    // KAO_URL falls back to its default; KAO_TOKEN has no default.
    expect(c.KAO_URL).toBe("https://api.kao.localhost");
    expect(c.KAO_TOKEN).toBeUndefined();
    expect(c.KIZUNA_HOST).toBe("127.0.0.1");
  });

  it("trims optional string values", () => {
    const c = loadConfig({
      ...validEnv,
      KAO_URL: "  https://api.kao.example  ",
      KAO_TOKEN: "  this-is-a-real-bearer  ",
    });
    expect(c.KAO_URL).toBe("https://api.kao.example");
    expect(c.KAO_TOKEN).toBe("this-is-a-real-bearer");
  });

  it("rejects a non-mongodb URI", () => {
    expect(() => loadConfig({ ...validEnv, MONGODB_URI: "http://nope" })).toThrow();
  });

  it("rejects malformed USER_EMAILS", () => {
    expect(() => loadConfig({ ...validEnv, USER_EMAILS: "not-an-email" })).toThrow();
  });

  it("rejects a non-URL KAO_URL", () => {
    expect(() => loadConfig({ ...validEnv, KAO_URL: "not-a-url" })).toThrow();
  });

  it("rejects a too-short KAO_TOKEN", () => {
    // The bearer is a shared secret with Kao — fail fast on something that
    // obviously isn't a real token rather than 401'ing at vend time.
    expect(() => loadConfig({ ...validEnv, KAO_TOKEN: "short" })).toThrow();
  });
});
