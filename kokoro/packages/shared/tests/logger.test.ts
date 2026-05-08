import { expect, it } from "vitest";
import { logger, loggerBase } from "../src/logger";

it("sets stable Kokoro service bindings", () => {
  const bindings = logger.bindings();

  expect(loggerBase).toMatchObject({
    pid: process.pid,
    service: "kokoro-bot",
    component: "bot",
  });
  expect(loggerBase.hostname.length).toBeGreaterThan(0);
  expect(loggerBase.env.length).toBeGreaterThan(0);

  expect(bindings).toMatchObject({
    service: "kokoro-bot",
    component: "bot",
  });
  expect(bindings).toHaveProperty("env");
});
