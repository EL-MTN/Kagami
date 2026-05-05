import pino from "pino";

export type Logger = pino.Logger;

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "kizuna-api" },
  transport:
    process.env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
          },
        }
      : undefined,
});
