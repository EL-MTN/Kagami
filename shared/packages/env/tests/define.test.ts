import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineEnv, kansokuShipper, kaoConsumer } from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("defineEnv", () => {
  it("enforces .meta({ doc }) on every var by default", () => {
    expect(() =>
      defineEnv({
        service: "test",
        component: "api",
        vars: { UNDOCUMENTED: z.string().optional() },
      }),
    ).toThrow(/UNDOCUMENTED.*\.meta/);
  });

  it("skips doc enforcement with requireDocs: false", () => {
    const spec = defineEnv({
      service: "test",
      component: "api",
      requireDocs: false,
      vars: { BARE: z.string().default("x") },
    });
    expect(spec.parse({}).BARE).toBe("x");
  });

  it("treats blank and whitespace-only values as unset, and trims kept values", () => {
    const spec = defineEnv({
      service: "test",
      component: "api",
      requireDocs: false,
      vars: {
        WITH_DEFAULT: z.string().default("fallback"),
        TRIMMED: z.string().optional(),
      },
    });
    const config = spec.parse({ WITH_DEFAULT: "   ", TRIMMED: "  value  " });
    expect(config.WITH_DEFAULT).toBe("fallback");
    expect(config.TRIMMED).toBe("value");
  });

  it("only reads declared keys from the env record (allowlist by construction)", () => {
    const spec = defineEnv({
      service: "test",
      component: "api",
      requireDocs: false,
      vars: { DECLARED: z.string().optional() },
    });
    const config = spec.parse({ DECLARED: "yes", SOMETHING_ELSE: "ignored" });
    expect(config).toEqual({ DECLARED: "yes" });
  });

  it("aggregates hard issues into one thrown error, one line per issue", () => {
    const spec = defineEnv({
      service: "test",
      component: "api",
      requireDocs: false,
      vars: {
        NEEDED: z.string(),
        NUMERIC: z.coerce.number().int().optional(),
      },
    });
    expect(() => spec.parse({ NUMERIC: "abc" })).toThrow(
      /Invalid environment configuration:\n {2}- (NEEDED|NUMERIC).*\n {2}- (NEEDED|NUMERIC)/,
    );
  });

  it('supports the "exit" mode: prints and exits 1 instead of throwing', () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const spec = defineEnv({
      service: "test",
      component: "api",
      requireDocs: false,
      vars: { NEEDED: z.string() },
    });
    expect(() => spec.parse({}, { onInvalid: "exit" })).toThrow("exited");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("NEEDED"));
  });

  it("falls back to the default on warn-default keys and reports the bad value", () => {
    const warns: unknown[] = [];
    const spec = defineEnv({
      service: "test",
      component: "api",
      requireDocs: false,
      vars: {
        TTL_DAYS: z.coerce
          .number()
          .int()
          .positive()
          .default(30)
          .meta({ doc: "ttl", onInvalid: "warn-default" }),
        OTHER: z.string().optional(),
      },
    });
    const config = spec.parse(
      { TTL_DAYS: "30days", OTHER: "kept" },
      { onWarn: (w) => warns.push(w) },
    );
    expect(config.TTL_DAYS).toBe(30);
    expect(config.OTHER).toBe("kept");
    expect(warns).toEqual([expect.objectContaining({ key: "TTL_DAYS", provided: "30days" })]);
  });

  it("escalates a warn-default key that has no default", () => {
    const spec = defineEnv({
      service: "test",
      component: "api",
      requireDocs: false,
      vars: {
        BROKEN: z.coerce.number().int().meta({ doc: "x", onInvalid: "warn-default" }),
      },
    });
    expect(() => spec.parse({ BROKEN: "abc" })).toThrow(/BROKEN/);
  });

  it("redacts secret values in the default warn-default console output", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const spec = defineEnv({
      service: "test",
      component: "api",
      requireDocs: false,
      vars: {
        SECRET_NUM: z.coerce
          .number()
          .default(1)
          .meta({ doc: "x", secret: true, onInvalid: "warn-default" }),
      },
    });
    spec.parse({ SECRET_NUM: "hunter2" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain("<redacted>");
    expect(line).not.toContain("hunter2");
  });

  it("resolves aliases when the canonical key is unset, canonical wins otherwise", () => {
    const spec = defineEnv({
      service: "test",
      component: "api",
      requireDocs: false,
      aliases: { MODEL: "LLM_MODEL" },
      vars: { LLM_MODEL: z.string().default("default-model") },
    });
    expect(spec.parse({ MODEL: "from-alias" }).LLM_MODEL).toBe("from-alias");
    expect(spec.parse({ MODEL: "from-alias", LLM_MODEL: "canonical" }).LLM_MODEL).toBe("canonical");
    expect(spec.parse({}).LLM_MODEL).toBe("default-model");
  });

  it("rejects an alias pointing at an undeclared key, or shadowing a declared one", () => {
    expect(() =>
      defineEnv({
        service: "test",
        component: "api",
        requireDocs: false,
        aliases: { MODEL: "NOPE" },
        vars: { LLM_MODEL: z.string().optional() },
      }),
    ).toThrow(/NOPE/);
    expect(() =>
      defineEnv({
        service: "test",
        component: "api",
        requireDocs: false,
        aliases: { LLM_MODEL: "LLM_MODEL" },
        vars: { LLM_MODEL: z.string().optional() },
      }),
    ).toThrow(/collides/);
  });

  it("runs cross-field checks after parse, and skips them with cross: 'skip'", () => {
    const spec = defineEnv({
      service: "test",
      component: "api",
      requireDocs: false,
      vars: {
        PROVIDER: z.enum(["a", "b"]).default("a"),
        A_KEY: z.string().optional(),
      },
      cross: [(config) => (config.PROVIDER === "a" && !config.A_KEY ? ["A_KEY is required"] : [])],
    });
    expect(() => spec.parse({})).toThrow(/A_KEY is required/);
    expect(spec.parse({}, { cross: "skip" }).PROVIDER).toBe("a");
    expect(spec.parse({ A_KEY: "k" }).A_KEY).toBe("k");
  });

  it("introspects required/default/optional for the generators", () => {
    const spec = defineEnv({
      service: "test",
      component: "api",
      requireDocs: false,
      vars: {
        REQUIRED: z.string(),
        DEFAULTED: z.coerce.number().default(42),
        OPTIONAL: z.string().optional(),
        TRANSFORMED: z
          .string()
          .default("true")
          .transform((s) => s === "true"),
      },
    });
    const byKey = Object.fromEntries(spec.keys.map((k) => [k.key, k]));
    expect(byKey.REQUIRED).toMatchObject({ required: true });
    expect(byKey.DEFAULTED).toMatchObject({ required: false, defaultValue: "42" });
    expect(byKey.OPTIONAL).toMatchObject({ required: false });
    expect(byKey.OPTIONAL?.defaultValue).toBeUndefined();
    // Transform defaults render the parsed output — callers needing the raw
    // env representation set meta.example instead.
    expect(byKey.TRANSFORMED).toMatchObject({ defaultValue: "true" });
  });
});

describe("kansokuShipper block", () => {
  it("drops an invalid KANSOKU_URL to undefined with a warn — never a boot failure", () => {
    const kansoku = kansokuShipper();
    const spec = defineEnv({
      service: "test",
      component: "api",
      vars: { ...kansoku.vars },
    });
    const warnings: string[] = [];
    const config = spec.parse(
      { KANSOKU_URL: "not-a-url", KANSOKU_INGEST_TOKEN: "tok" },
      { onWarn: (w) => warnings.push(w.key) },
    );
    expect(config.KANSOKU_URL).toBeUndefined();
    expect(warnings).toEqual(["KANSOKU_URL"]);
    // A valid pair passes through untouched.
    const ok = spec.parse({
      KANSOKU_URL: "https://api.kansoku.localhost",
      KANSOKU_INGEST_TOKEN: "tok",
    });
    expect(ok.KANSOKU_URL).toBe("https://api.kansoku.localhost");
  });
});

describe("kaoConsumer block", () => {
  it("is hard both-or-neither, with the min(16) bearer floor", () => {
    const kao = kaoConsumer();
    const spec = defineEnv({
      service: "test",
      component: "bot",
      vars: { ...kao.vars },
      cross: [...kao.cross],
    });
    expect(() => spec.parse({ KAO_URL: "https://api.kao.localhost" })).toThrow(
      /KAO_TOKEN is required/,
    );
    expect(() => spec.parse({ KAO_TOKEN: "x".repeat(32) })).toThrow(/KAO_URL is required/);
    expect(() => spec.parse({ KAO_URL: "https://api.kao.localhost", KAO_TOKEN: "short" })).toThrow(
      /at least 16/,
    );
    const config = spec.parse({
      KAO_URL: "https://api.kao.localhost",
      KAO_TOKEN: "x".repeat(32),
    });
    expect(config.KAO_URL).toBe("https://api.kao.localhost");
    expect(spec.parse({})).toEqual({});
  });

  it("rejects a KAO_URL that is not host-only", () => {
    const kao = kaoConsumer();
    const spec = defineEnv({
      service: "test",
      component: "bot",
      vars: { ...kao.vars },
      cross: [...kao.cross],
    });
    const token = "x".repeat(32);
    for (const url of [
      "https://api.kao.localhost/api",
      "https://api.kao.localhost?debug=1",
      "https://api.kao.localhost/#frag",
      "https://user:secret@api.kao.localhost",
    ]) {
      expect(() => spec.parse({ KAO_URL: url, KAO_TOKEN: token })).toThrow(/host-only/);
    }
    // A trailing slash is still an origin, not a path.
    const config = spec.parse({ KAO_URL: "https://api.kao.localhost/", KAO_TOKEN: token });
    expect(config.KAO_URL).toBe("https://api.kao.localhost/");
  });
});
