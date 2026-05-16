import { expect, it } from "vitest";
import { logger } from "../src/logger.ts";

it("sets stable Kioku service bindings (ECS shape)", () => {
  expect(logger.bindings()).toMatchObject({
    service: { name: "kioku-api", component: "api" },
  });
  expect(logger.bindings()).toHaveProperty("service.environment");
});
