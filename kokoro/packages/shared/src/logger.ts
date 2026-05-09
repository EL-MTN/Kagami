import { hostname } from "node:os";
import pino from "pino";
import { config } from "./config";

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
  service: "kokoro-bot",
  component: "bot",
  env: config.NODE_ENV,
};

export const logger = pino({
  level: config.LOG_LEVEL,
  base: loggerBase,
  redact: {
    paths: redactPaths,
    censor: "[redacted]",
  },
  formatters: {
    log(bindings) {
      // Strip base64 image data from logs
      if ("imageData" in bindings) {
        return { ...bindings, imageData: "[base64 omitted]" };
      }
      return bindings;
    },
  },
  transport:
    config.NODE_ENV === "development"
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
