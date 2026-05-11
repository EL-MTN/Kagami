import { hostname } from "node:os";
import pino from "pino";
import type { LoggerOptions } from "pino";

export const DEFAULT_REDACT_PATHS = [
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

export interface ServiceBindings {
  service: string;
  component: string;
  env: string;
}

export interface LoggerBaseBindings extends ServiceBindings {
  pid: number;
  hostname: string;
}

// Snapshot pid + hostname eagerly at call time so loggers built at module load
// don't drift if a later refactor wraps them in a deferred factory.
export function buildLoggerBase(bindings: ServiceBindings): LoggerBaseBindings {
  return {
    pid: process.pid,
    hostname: hostname(),
    ...bindings,
  };
}

export interface CreateLoggerOptions extends ServiceBindings {
  level?: string;
  formatters?: LoggerOptions["formatters"];
}

export function createLogger(opts: CreateLoggerOptions): pino.Logger {
  const { service, component, env, level = "info", formatters } = opts;

  return pino({
    level,
    base: buildLoggerBase({ service, component, env }),
    redact: {
      paths: DEFAULT_REDACT_PATHS,
      censor: "[redacted]",
    },
    ...(formatters ? { formatters } : {}),
    transport:
      env !== "production"
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
}

export type { Logger } from "pino";
