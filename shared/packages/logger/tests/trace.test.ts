import { describe, expect, it } from "vitest";
import {
  childSpan,
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  getTraceContext,
  newTraceContext,
  parseTraceparent,
  runWithTrace,
} from "../src/trace";

describe("trace IDs", () => {
  it("generateTraceId returns 32 lowercase hex chars", () => {
    const id = generateTraceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generateSpanId returns 16 lowercase hex chars", () => {
    const id = generateSpanId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("each call returns a distinct id (no module-level state)", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateTraceId()));
    expect(ids.size).toBe(50);
  });
});

describe("traceparent parse / format", () => {
  it("round-trips a sampled context", () => {
    const ctx = { traceId: "a".repeat(32), spanId: "b".repeat(16), sampled: true };
    const header = formatTraceparent(ctx);
    expect(header).toBe(`00-${"a".repeat(32)}-${"b".repeat(16)}-01`);
    expect(parseTraceparent(header)).toEqual(ctx);
  });

  it("round-trips an unsampled context", () => {
    const ctx = { traceId: "c".repeat(32), spanId: "d".repeat(16), sampled: false };
    expect(parseTraceparent(formatTraceparent(ctx))).toEqual(ctx);
  });

  it("rejects all-zero trace ids per W3C", () => {
    expect(parseTraceparent(`00-${"0".repeat(32)}-${"b".repeat(16)}-01`)).toBeUndefined();
  });

  it("rejects all-zero span ids per W3C", () => {
    expect(parseTraceparent(`00-${"a".repeat(32)}-${"0".repeat(16)}-01`)).toBeUndefined();
  });

  it("rejects malformed headers", () => {
    expect(parseTraceparent("garbage")).toBeUndefined();
    expect(parseTraceparent("01-abc-def-00")).toBeUndefined();
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent(null)).toBeUndefined();
    expect(parseTraceparent("")).toBeUndefined();
  });

  it("normalizes uppercase hex on parse", () => {
    const ctx = parseTraceparent(`00-${"A".repeat(32)}-${"B".repeat(16)}-01`);
    expect(ctx?.traceId).toBe("a".repeat(32));
    expect(ctx?.spanId).toBe("b".repeat(16));
  });
});

describe("childSpan", () => {
  it("keeps the trace id and threads the parent span", () => {
    const parent = newTraceContext();
    const child = childSpan(parent);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.spanId).not.toBe(parent.spanId);
    expect(child.sampled).toBe(parent.sampled);
  });
});

describe("head sampling", () => {
  const KEY = "LOG_SAMPLE_RATE";

  function withRate(value: string | undefined, fn: () => void): void {
    const saved = process.env[KEY];
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    }
  }

  it("defaults to sampled when LOG_SAMPLE_RATE is unset", () => {
    withRate(undefined, () => expect(newTraceContext().sampled).toBe(true));
  });

  it("rate 0 makes fresh roots unsampled; rate 1 keeps them sampled", () => {
    withRate("0", () => expect(newTraceContext().sampled).toBe(false));
    withRate("1", () => expect(newTraceContext().sampled).toBe(true));
  });

  it("an explicit sampled flag overrides the rate", () => {
    withRate("0", () => expect(newTraceContext({ sampled: true }).sampled).toBe(true));
    withRate("1", () => expect(newTraceContext({ sampled: false }).sampled).toBe(false));
  });

  it("fails open (sampled) on an unparseable rate", () => {
    withRate("garbage", () => expect(newTraceContext().sampled).toBe(true));
  });

  it("a sampled-out root propagates through childSpan and traceparent", () => {
    withRate("0", () => {
      const root = newTraceContext();
      expect(root.sampled).toBe(false);
      expect(childSpan(root).sampled).toBe(false);
      const reparsed = parseTraceparent(formatTraceparent(root));
      expect(reparsed?.sampled).toBe(false);
    });
  });
});

describe("AsyncLocalStorage propagation", () => {
  it("getTraceContext returns undefined outside any scope", () => {
    expect(getTraceContext()).toBeUndefined();
  });

  it("runWithTrace makes the context visible synchronously", () => {
    const ctx = newTraceContext();
    runWithTrace(ctx, () => {
      expect(getTraceContext()).toEqual(ctx);
    });
    expect(getTraceContext()).toBeUndefined();
  });

  it("survives async boundaries", async () => {
    const ctx = newTraceContext();
    await runWithTrace(ctx, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 5));
      expect(getTraceContext()).toEqual(ctx);
    });
  });

  it("nested scopes shadow correctly", () => {
    const outer = newTraceContext();
    const inner = newTraceContext();
    runWithTrace(outer, () => {
      expect(getTraceContext()?.traceId).toBe(outer.traceId);
      runWithTrace(inner, () => {
        expect(getTraceContext()?.traceId).toBe(inner.traceId);
      });
      expect(getTraceContext()?.traceId).toBe(outer.traceId);
    });
  });
});
