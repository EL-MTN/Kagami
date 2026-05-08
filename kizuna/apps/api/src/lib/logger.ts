import { hostname } from "node:os";
import pino from "pino";

export type Logger = pino.Logger;

const redactPaths = [
  "authorization",
  "cookie",
  "password",
  "token",
  "apiKey",
  "api_key",
  "secret",
  "accessToken",
  "refreshToken",
  "headers.authorization",
  "headers.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "*.authorization",
  "*.cookie",
  "*.password",
  "*.token",
  "*.apiKey",
  "*.api_key",
  "*.secret",
  "*.accessToken",
  "*.refreshToken",
];

export const loggerBase = {
  pid: process.pid,
  hostname: hostname(),
  service: "kizuna-api",
  component: "api",
  env: process.env.NODE_ENV ?? "development",
};

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: loggerBase,
  redact: {
    paths: redactPaths,
    censor: "[redacted]",
  },
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
