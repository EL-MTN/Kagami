import { describe, expect, it, vi } from "vitest";

vi.mock("@kokoro/shared", async (orig) => {
  const actual = await orig<typeof import("@kokoro/shared")>();
  return {
    ...actual,
    config: { ...actual.config, TIMEZONE: "America/Los_Angeles" },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
    },
  };
});

import { createGetCurrentTimeTool } from "../../../src/ai/tools/time";

interface ExecutableTool {
  execute: (input: Record<string, unknown>, options?: unknown) => Promise<Record<string, unknown>>;
}

const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

describe("getCurrentTime tool", () => {
  const tool = createGetCurrentTimeTool() as unknown as ExecutableTool;

  it("defaults to the configured timezone and returns formatted + ISO-with-offset", async () => {
    const result = await tool.execute({});
    expect(result.success).toBe(true);
    expect(result.timezone).toBe("America/Los_Angeles");
    expect(typeof result.formatted).toBe("string");
    expect(result.iso as string).toMatch(ISO_OFFSET);
    // Pacific is -07:00 (PDT) or -08:00 (PST) depending on the season.
    expect(result.iso as string).toMatch(/-0[78]:00$/);
  });

  it("honors an explicit IANA timezone (Tokyo is always +09:00, no DST)", async () => {
    const result = await tool.execute({ timezone: "Asia/Tokyo" });
    expect(result.success).toBe(true);
    expect(result.timezone).toBe("Asia/Tokyo");
    expect(result.iso as string).toMatch(/\+09:00$/);
  });

  it("renders UTC as +00:00", async () => {
    const result = await tool.execute({ timezone: "UTC" });
    expect(result.success).toBe(true);
    expect(result.iso as string).toMatch(/\+00:00$/);
  });

  it("returns success:false for an unknown timezone rather than throwing", async () => {
    const result = await tool.execute({ timezone: "Not/AZone" });
    expect(result.success).toBe(false);
    expect(result.reason as string).toMatch(/Invalid timezone/);
  });
});
