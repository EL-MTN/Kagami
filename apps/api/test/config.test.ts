import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const validEnv = {
  KIZUNA_API_KEY: "a-very-long-test-api-key-1234567890",
  MONGO_URI: "mongodb://127.0.0.1:27017/kizuna",
  USER_EMAILS: "me@example.com,you@example.com",
};

describe("loadConfig", () => {
  it("parses a valid env and applies defaults", () => {
    const c = loadConfig(validEnv);
    expect(c.USER_EMAILS).toEqual(["me@example.com", "you@example.com"]);
    expect(c.PORT).toBe(3000);
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

  it("rejects a missing KIZUNA_API_KEY", () => {
    const env = { ...validEnv } as Record<string, string | undefined>;
    delete env.KIZUNA_API_KEY;
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(/KIZUNA_API_KEY/);
  });

  it("rejects a too-short KIZUNA_API_KEY", () => {
    expect(() => loadConfig({ ...validEnv, KIZUNA_API_KEY: "short" })).toThrow();
  });

  it("rejects a non-mongodb URI", () => {
    expect(() => loadConfig({ ...validEnv, MONGO_URI: "http://nope" })).toThrow();
  });

  it("rejects malformed USER_EMAILS", () => {
    expect(() => loadConfig({ ...validEnv, USER_EMAILS: "not-an-email" })).toThrow();
  });
});
