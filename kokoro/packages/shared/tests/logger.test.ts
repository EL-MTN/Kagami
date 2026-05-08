import { expect, it } from "vitest";
import { logger } from "../src/logger";

it("sets stable Kokoro service bindings", () => {
  expect(logger.bindings()).toMatchObject({
    service: "kokoro-bot",
    component: "bot",
  });
});
