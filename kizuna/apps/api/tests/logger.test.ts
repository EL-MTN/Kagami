import { expect, it } from "vitest";
import { logger } from "../src/lib/logger.js";

it("sets stable Kizuna service bindings (ECS shape)", () => {
  expect(logger.bindings()).toMatchObject({
    service: { name: "kizuna-api", component: "api" },
  });
  expect(logger.bindings()).toHaveProperty("service.environment");
});
