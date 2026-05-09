import { describe, expect, it } from "vitest";
import { DEFAULT_REDACT_PATHS, buildLoggerBase, createLogger } from "../src/index";

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
});
