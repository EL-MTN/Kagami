import { createLogger, type Logger } from "@kagami/logger";

export type { Logger };

export const logger: Logger = createLogger({
  service: "kizuna-api",
  component: "api",
  env: process.env.NODE_ENV ?? "development",
  level: process.env.LOG_LEVEL ?? "info",
});
