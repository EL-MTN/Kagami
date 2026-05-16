import { expect, it } from "vitest";
import { logger } from "../src/logger";

it("sets stable Kokoro service bindings (ECS shape)", () => {
  expect(logger.bindings()).toMatchObject({
    service: { name: "kokoro-bot", component: "bot" },
  });
  expect(logger.bindings()).toHaveProperty("service.environment");
});
