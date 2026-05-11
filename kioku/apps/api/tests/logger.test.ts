import { expect, it } from "vitest";
import { logger } from "../src/logger.ts";

it("sets stable Kioku service bindings", () => {
  expect(logger.bindings()).toMatchObject({
    service: "kioku-api",
    component: "api",
  });
  expect(logger.bindings()).toHaveProperty("env");
});
