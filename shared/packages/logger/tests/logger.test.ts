import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { DEFAULT_REDACT_PATHS, buildLoggerBase, createLogger } from "../src/index";
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
  it("exposes stable service/component/env bindings", () => {
    const logger = createLogger({
      service: "test-service",
      component: "test-component",
      env: "test",
    });

    expect(logger.bindings()).toMatchObject({
      service: "test-service",
      component: "test-component",
      env: "test",
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

  it("redacts common secret paths by default", () => {
    expect(DEFAULT_REDACT_PATHS).toEqual(
      expect.arrayContaining([
        "authorization",
        "password",
        "token",
        "secret",
        "headers.authorization",
        "*.password",
      ]),
    );
  });

  it("includes imageData in the redact path list", () => {
    expect(DEFAULT_REDACT_PATHS).toEqual(expect.arrayContaining(["imageData", "*.imageData"]));
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
