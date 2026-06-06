import { describe, expect, it, vi } from "vitest";

vi.mock("@kokoro/shared", async (orig) => {
  const actual = await orig<typeof import("@kokoro/shared")>();
  return {
    ...actual,
    config: { ...actual.config, TIMEZONE: "America/Los_Angeles" },
  };
});

import { DATE_CONTEXT, currentTimeContext, isoWithOffset } from "../../src/ai/prompts";

// A fixed instant: 2026-06-05T22:34:00Z = 3:34 PM PDT (June → daylight time).
const JUNE = new Date("2026-06-05T22:34:00Z");
// 2026-01-15T22:34:00Z = 2:34 PM PST (January → standard time).
const JAN = new Date("2026-01-15T22:34:00Z");

const CLOCK = /\b\d{1,2}:\d{2}\b/;
const ISO_OFFSET = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/;

describe("DATE_CONTEXT (system-prefix, date-only)", () => {
  it("includes the date, timezone, and time-of-day", () => {
    const out = DATE_CONTEXT(JUNE);
    expect(out).toContain("Today is");
    expect(out).toContain("June 5, 2026");
    expect(out).toContain("America/Los_Angeles");
    expect(out).toContain("Time of day:");
  });

  it("omits the clock time so the cached prefix stays stable across a day", () => {
    const out = DATE_CONTEXT(JUNE);
    expect(out).not.toMatch(CLOCK);
    expect(out).not.toMatch(/\b(AM|PM)\b/i);
  });

  it("is identical for two times in the same time-of-day bucket (no per-minute churn)", () => {
    // Both afternoon (local hour < 17): 12:30 PM and 4:30 PM PDT. The prefix
    // changes at most once/day plus the few time-of-day boundary crossings —
    // never per message.
    const earlyAfternoon = new Date("2026-06-05T19:30:00Z"); // 12:30 PM PDT
    const lateAfternoon = new Date("2026-06-05T23:30:00Z"); // 4:30 PM PDT
    expect(DATE_CONTEXT(earlyAfternoon)).toBe(DATE_CONTEXT(lateAfternoon));
  });
});

describe("currentTimeContext (tail, precise)", () => {
  it("carries the clock time and an ISO-8601 offset", () => {
    const out = currentTimeContext(JUNE);
    expect(out).toContain("Current time:");
    expect(out).toMatch(CLOCK);
    expect(out).toMatch(ISO_OFFSET);
  });
});

describe("isoWithOffset", () => {
  it("renders Pacific daylight time (June) as -07:00", () => {
    expect(isoWithOffset(JUNE, "America/Los_Angeles")).toBe("2026-06-05T15:34:00-07:00");
  });

  it("renders Pacific standard time (January) as -08:00 — DST aware", () => {
    expect(isoWithOffset(JAN, "America/Los_Angeles")).toBe("2026-01-15T14:34:00-08:00");
  });

  it("renders UTC as +00:00", () => {
    expect(isoWithOffset(JUNE, "UTC")).toBe("2026-06-05T22:34:00+00:00");
  });

  it("renders Tokyo as +09:00", () => {
    expect(isoWithOffset(JUNE, "Asia/Tokyo")).toBe("2026-06-06T07:34:00+09:00");
  });
});
