import { expect, it } from "vitest";
import { logger, loggerBase } from "../src/logger.ts";

it("sets stable Kioku service bindings", () => {
  const bindings = logger.bindings();

  expect(loggerBase).toMatchObject({
    pid: process.pid,
    service: "kioku-api",
    component: "api",
  });
  expect(loggerBase.hostname.length).toBeGreaterThan(0);
  expect(loggerBase.env.length).toBeGreaterThan(0);

  expect(bindings).toMatchObject({
    service: "kioku-api",
    component: "api",
  });
  expect(bindings).toHaveProperty("env");
});
