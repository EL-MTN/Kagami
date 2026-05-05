import { describe, expect, it } from "vitest";

import { computeNextRunAt, validateCronAndDefaults } from "../src/routine-validation";

describe("computeNextRunAt", () => {
  it("returns the next-fire time relative to a fixed `from`", () => {
    // Fri 2026-01-02 10:00:00 UTC — "every minute" should fire at 10:01:00.
    const from = new Date(Date.UTC(2026, 0, 2, 10, 0, 0));
    const next = computeNextRunAt("* * * * *", from);
    expect(next.getTime()).toBe(Date.UTC(2026, 0, 2, 10, 1, 0));
  });

  it("handles hourly schedules across day boundaries", () => {
    // 23:30 → next "0 * * * *" is 00:00 the following day.
    const from = new Date(Date.UTC(2026, 0, 2, 23, 30, 0));
    const next = computeNextRunAt("0 * * * *", from);
    expect(next.getTime()).toBe(Date.UTC(2026, 0, 3, 0, 0, 0));
  });

  it("defaults `from` to current time when omitted", () => {
    const before = Date.now();
    const next = computeNextRunAt("* * * * *");
    expect(next.getTime()).toBeGreaterThan(before);
  });

  it("throws on an invalid cron expression", () => {
    expect(() => computeNextRunAt("not a cron")).toThrow();
  });
});

describe("validateCronAndDefaults", () => {
  it("returns null when cronSchedule is null", () => {
    expect(validateCronAndDefaults(null, [])).toBeNull();
  });

  it("returns null when cronSchedule is undefined", () => {
    expect(validateCronAndDefaults(undefined, [])).toBeNull();
  });

  it("returns null when cronSchedule is the empty string", () => {
    expect(validateCronAndDefaults("", [])).toBeNull();
  });

  it("returns invalid-cron for malformed expressions", () => {
    const result = validateCronAndDefaults("not a cron", []);
    expect(result).toEqual({
      kind: "invalid-cron",
      message: 'Invalid cron expression: "not a cron"',
    });
  });

  it("returns null when all required parameters have defaults", () => {
    const result = validateCronAndDefaults("0 * * * *", [
      { name: "topic", required: true, default: "news" },
      { name: "limit", required: true, default: 5 },
      { name: "optional", required: false },
    ]);
    expect(result).toBeNull();
  });

  it("returns missing-defaults listing every required param without a default", () => {
    const result = validateCronAndDefaults("0 * * * *", [
      { name: "topic", required: true },
      { name: "ok", required: true, default: "x" },
      { name: "limit", required: true },
    ]);
    expect(result).toEqual({
      kind: "missing-defaults",
      missing: ["topic", "limit"],
      message:
        "Cron-scheduled routines require defaults for all required parameters. Missing: topic, limit",
    });
  });

  it("treats a parameter with `default: null` as having a default", () => {
    // The check is `default === undefined` — explicit null counts as "set".
    const result = validateCronAndDefaults("0 * * * *", [
      { name: "x", required: true, default: null },
    ]);
    expect(result).toBeNull();
  });

  it("ignores non-required params even when they have no default", () => {
    const result = validateCronAndDefaults("0 * * * *", [{ name: "x", required: false }]);
    expect(result).toBeNull();
  });
});
