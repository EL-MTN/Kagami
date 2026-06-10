import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config.js";

describe("loadEnv", () => {
  it("hard-fails on a malformed MONGODB_URI instead of defaulting to localhost", () => {
    expect(() => loadEnv({ MONGODB_URI: "mongo://typo-scheme" })).toThrow(/MONGODB_URI/);
  });

  it("warn-defaults tuning knobs (an operator typo never crashes boot)", () => {
    const config = loadEnv({
      KANSOKU_LOGS_TTL_DAYS: "30days",
      KANSOKU_SPIKE_THRESHOLD: "1",
    });
    expect(config.KANSOKU_LOGS_TTL_DAYS).toBe(30);
    expect(config.KANSOKU_SPIKE_THRESHOLD).toBe(10);
  });

  it("memoizes per raw env values and re-parses when they change", () => {
    expect(loadEnv({ KANSOKU_SPIKE_THRESHOLD: "5" }).KANSOKU_SPIKE_THRESHOLD).toBe(5);
    expect(loadEnv({ KANSOKU_SPIKE_THRESHOLD: "7" }).KANSOKU_SPIKE_THRESHOLD).toBe(7);
  });
});
