// Pin the TZ before any Date use so the UTC-vs-local assertions are
// deterministic regardless of the host machine's zone. Vitest runs each
// file in its own worker, so this does not leak into other suites.
process.env.TZ = "America/Los_Angeles";

import { describe, expect, it } from "vitest";
import { localDateOf, localToday, sessionDateOf } from "../src/dates.ts";

describe("localDateOf", () => {
  it("formats a local-constructed date as its local calendar day", () => {
    expect(localDateOf(new Date(2026, 5, 10))).toBe("2026-06-10");
  });

  it("converts a UTC instant past local midnight back to the local day", () => {
    // 06:01 UTC on June 11 is 11:01 PM PDT on June 10.
    expect(localDateOf(new Date("2026-06-11T06:01:59.210Z"))).toBe("2026-06-10");
  });
});

describe("localToday", () => {
  it("matches localDateOf(now)", () => {
    expect(localToday()).toBe(localDateOf(new Date()));
  });
});

describe("KIOKU_TIMEZONE override", () => {
  it("resolves calendar days in the configured zone, not the process zone", () => {
    // 06:01 UTC June 11 = June 10 in PDT (process zone) but June 11 in Tokyo.
    const instant = new Date("2026-06-11T06:01:59.210Z");
    expect(localDateOf(instant)).toBe("2026-06-10");
    process.env.KIOKU_TIMEZONE = "Asia/Tokyo";
    try {
      expect(localDateOf(instant)).toBe("2026-06-11");
    } finally {
      delete process.env.KIOKU_TIMEZONE;
    }
    expect(localDateOf(instant)).toBe("2026-06-10");
  });
});

describe("sessionDateOf", () => {
  it("converts a Z-instant to the local calendar day", () => {
    // The live-store defect: an 11 PM PDT session sliced as UTC named
    // the next day.
    expect(sessionDateOf("2026-05-15T06:01:59.210Z")).toBe("2026-05-14");
  });

  it("keeps a date-only value verbatim (no UTC-midnight reinterpretation)", () => {
    expect(sessionDateOf("2026-05-15")).toBe("2026-05-15");
  });

  it("keeps a YAML-inflated bare date on its named day", () => {
    // js-yaml parses unquoted `started_at: 2026-05-15` into a UTC-midnight
    // Date; types.ts stringifies it. The named day must survive — not
    // shift to May 14 in PDT.
    expect(sessionDateOf("2026-05-15T00:00:00.000Z")).toBe("2026-05-15");
    expect(sessionDateOf(new Date("2026-05-15T00:00:00.000Z"))).toBe("2026-05-15");
  });

  it("keeps the local day of a naive datetime", () => {
    expect(sessionDateOf("2026-05-15T22:30:00")).toBe("2026-05-15");
  });

  it("normalizes longmemeval-style slash dates via naive-local parse", () => {
    // V8 parses this as 02:21 local — the calendar day is preserved and
    // the output gains canonical dashes.
    expect(sessionDateOf("2023/05/20 (Sat) 02:21")).toBe("2023-05-20");
  });

  it("falls back to the legacy 10-char slice for unparsable input", () => {
    expect(sessionDateOf("not-a-date-at-all")).toBe("not-a-date");
  });
});
