import { expect, it } from "vitest";
import { logger, loggerBase } from "../src/lib/logger.js";

it("sets stable Kizuna service bindings", () => {
  const bindings = logger.bindings();

  expect(loggerBase).toMatchObject({
    pid: process.pid,
    service: "kizuna-api",
    component: "api",
  });
  expect(loggerBase.hostname.length).toBeGreaterThan(0);
  expect(loggerBase.env.length).toBeGreaterThan(0);

  expect(bindings).toMatchObject({
    service: "kizuna-api",
    component: "api",
  });
  expect(bindings).toHaveProperty("env");
});
