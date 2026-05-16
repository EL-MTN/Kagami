import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { buildLoggerBase, createLogger } from "../src/index";
import { getTraceContext, newTraceContext, runWithTrace } from "../src/trace";

describe("buildLoggerBase", () => {
  it("snapshots pid and hostname at call time alongside service bindings", () => {
    const base = buildLoggerBase({
      service: "test-service",
      component: "test-component",
      env: "test",
    });

    expect(base.pid).toBe(process.pid);
    expect(base.hostname.length).toBeGreaterThan(0);
    expect(base).toMatchObject({
      service: "test-service",
      component: "test-component",
      env: "test",
    });
  });
});

describe("createLogger", () => {
  it("exposes stable service/component/env bindings in ECS shape", () => {
    const logger = createLogger({
      service: "test-service",
      component: "test-component",
      env: "test",
    });

    // `formatters.bindings` remaps base bindings to ECS resource fields, and
    // pino applies it to `.bindings()` too.
    expect(logger.bindings()).toMatchObject({
      service: { name: "test-service", component: "test-component", environment: "test" },
    });
  });

  it("respects the provided log level", () => {
    const logger = createLogger({
      service: "test-service",
      component: "test-component",
      env: "test",
      level: "warn",
    });

    expect(logger.level).toBe("warn");
  });

  it("defaults the log level to info", () => {
    const logger = createLogger({
      service: "test-service",
      component: "test-component",
      env: "test",
    });

    expect(logger.level).toBe("info");
  });

  it("throws when called with a level that is not in pino's vocabulary", () => {
    expect(() =>
      createLogger({
        service: "test-service",
        component: "test-component",
        env: "test",
        level: "INFO",
        kansoku: { url: "https://api.kansoku.localhost", token: "t" },
      }),
    ).toThrow(/invalid level/i);
  });
});

// The shipping pino mixin reads trace context from AsyncLocalStorage. Verify
// log records carry traceId/spanId only when inside a traced scope. Use a
// hand-built pino with the same mixin so we don't have to scrape stdout.
describe("trace mixin enrichment", () => {
  interface Record {
    msg: string;
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
  }

  function makeProbeLogger(): { logger: pino.Logger; lines: Record[] } {
    const lines: Record[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const line of text.split("\n").filter(Boolean)) {
        lines.push(JSON.parse(line) as Record);
      }
    });
    // Re-create createLogger's mixin behavior by instantiating pino directly
    // with the same option shape — keeps this test independent of stdout
    // transport configuration.
    const logger = pino(
      {
        mixin: () => {
          const ctx = getTraceContext();
          if (!ctx) return {};
          return ctx.parentSpanId
            ? { traceId: ctx.traceId, spanId: ctx.spanId, parentSpanId: ctx.parentSpanId }
            : { traceId: ctx.traceId, spanId: ctx.spanId };
        },
      },
      stream,
    );
    return { logger, lines };
  }

  it("adds traceId/spanId inside a traced scope", () => {
    const { logger, lines } = makeProbeLogger();
    const ctx = newTraceContext();
    runWithTrace(ctx, () => {
      logger.info("hello");
    });
    expect(lines[0]?.traceId).toBe(ctx.traceId);
    expect(lines[0]?.spanId).toBe(ctx.spanId);
  });

  it("omits trace fields outside any scope", () => {
    const { logger, lines } = makeProbeLogger();
    logger.info("hello");
    expect(lines[0]?.traceId).toBeUndefined();
    expect(lines[0]?.spanId).toBeUndefined();
  });
});

// Pino's default mixinMergeStrategy is `Object.assign(mixinObject, mergeObject)`
// — the mixin's return value is the *target*. Returning a frozen sentinel
// breaks `logger.info({ ... }, "msg")` calls outside a trace context with a
// TypeError ("Cannot add property … object is not extensible"). This test
// goes through the real `createLogger` factory (not a hand-built pino) so it
// would catch a regression of that exact mistake.
describe("createLogger end-to-end logs outside a trace context", () => {
  it("does not throw on a logger.info({...}, msg) call outside any scope", () => {
    const logger = createLogger({
      service: "test-service",
      component: "test-component",
      env: "test",
    });
    expect(() => logger.info({ host: "127.0.0.1", port: 1234 }, "startup")).not.toThrow();
  });

  it("does not throw on a logger.error({ error }, msg) call inside a trace scope either", () => {
    const logger = createLogger({
      service: "test-service",
      component: "test-component",
      env: "test",
    });
    const ctx = newTraceContext();
    expect(() =>
      runWithTrace(ctx, () => {
        logger.error({ error: new Error("boom") }, "ingest failed");
      }),
    ).not.toThrow();
  });
});

// The factory wires pino's standard error serializer onto the `error` key
// (the workspace-wide convention). Verify an Error logged as { error } is
// expanded to type/message/stack rather than collapsed to "{}". Mirror the
// factory's serializer option on a hand-built pino so the line is scrapeable.
describe("error serializer", () => {
  interface ErrRecord {
    error?: { type?: string; message?: string; stack?: string };
  }

  it("expands an Error logged under the `error` key to type/message/stack", () => {
    const lines: ErrRecord[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const line of text.split("\n").filter(Boolean)) {
        lines.push(JSON.parse(line) as ErrRecord);
      }
    });
    const logger = pino({ serializers: { error: pino.stdSerializers.err } }, stream);

    logger.error({ error: new Error("boom") }, "ingest failed");

    expect(lines[0]?.error?.type).toBe("Error");
    expect(lines[0]?.error?.message).toBe("boom");
    expect(lines[0]?.error?.stack).toMatch(/Error: boom/);
  });
});
