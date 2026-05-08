import { pino } from "pino";

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

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: {
    service: "kioku-api",
    component: "api",
    env: process.env.NODE_ENV ?? "development",
  },
  redact: {
    paths: redactPaths,
    censor: "[redacted]",
  },
  transport:
    process.env.NODE_ENV !== "production"
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
