import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config.js";

describe("loadEnv", () => {
  it("hard-fails on a malformed MONGODB_URI instead of defaulting to localhost", () => {
    expect(() => loadEnv({ MONGODB_URI: "mongo://typo-scheme" })).toThrow(/MONGODB_URI/);
  });

  it("honors the legacy MODEL alias, including in the memo key", () => {
    // Two consecutive calls differing ONLY in the alias must both be honored —
    // the memo key has to track aliases, not just canonical key names.
    expect(loadEnv({ MODEL: "bench-model-a" }).LLM_MODEL).toBe("bench-model-a");
    expect(loadEnv({ MODEL: "bench-model-b" }).LLM_MODEL).toBe("bench-model-b");
    // Canonical wins when both are set.
    expect(loadEnv({ MODEL: "bench-model-a", LLM_MODEL: "canonical" }).LLM_MODEL).toBe("canonical");
  });

  it("warn-defaults tuning knobs (KIOKU_TOP_K typo degrades, never crashes)", () => {
    expect(loadEnv({ KIOKU_TOP_K: "abc" }).KIOKU_TOP_K).toBe(50);
  });
});
