import { createLogger } from "@kagami/logger";

export const logger = createLogger({
  service: "kioku-api",
  component: "api",
  env: process.env.NODE_ENV ?? "development",
  level: process.env.LOG_LEVEL ?? "info",
});
