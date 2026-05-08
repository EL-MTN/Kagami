import { expect, it } from "vitest";
import { logger } from "../src/lib/logger.js";

it("sets stable Kizuna service bindings", () => {
  expect(logger.bindings()).toMatchObject({
    service: "kizuna-api",
    component: "api",
  });
});
