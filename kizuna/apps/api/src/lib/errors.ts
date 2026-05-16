import type { ErrorRequestHandler } from "express";
import mongoose from "mongoose";
import { ZodError } from "zod";
import { logger } from "./logger.js";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const errors = {
  badRequest: (message: string, details?: unknown) =>
    new HttpError(400, "bad_request", message, details),
  unauthorized: (message = "unauthorized") => new HttpError(401, "unauthorized", message),
  notFound: (message = "not found") => new HttpError(404, "not_found", message),
  conflict: (message: string, details?: unknown) =>
    new HttpError(409, "conflict", message, details),
  rateLimited: (message = "rate limited") => new HttpError(429, "rate_limited", message),
  internal: (message = "internal error") => new HttpError(500, "internal", message),
};

function envelope(code: string, message: string, details?: unknown) {
  const body: { error: { code: string; message: string; details?: unknown } } = {
    error: { code, message },
  };
  if (details !== undefined) body.error.details = details;
  return body;
}

export function makeErrorHandler(): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const ctx = { method: req.method, route: req.originalUrl };

    if (err instanceof HttpError) {
      if (err.status >= 500) {
        logger.error({ error: err, ...ctx, status: err.status, code: err.code }, "request failed");
      } else {
        logger.warn(
          { ...ctx, status: err.status, code: err.code, message: err.message },
          "request rejected",
        );
      }
      res.status(err.status).json(envelope(err.code, err.message, err.details));
      return;
    }
    if (err instanceof ZodError) {
      logger.warn({ ...ctx, status: 400, code: "bad_request" }, "request rejected (zod)");
      res.status(400).json(envelope("bad_request", "invalid input", err.issues));
      return;
    }
    if (err instanceof mongoose.Error.ValidationError) {
      logger.warn(
        { ...ctx, status: 400, code: "bad_request" },
        "request rejected (mongoose validation)",
      );
      res.status(400).json(envelope("bad_request", "validation failed", err.errors));
      return;
    }
    if (err instanceof mongoose.Error.CastError) {
      logger.warn(
        { ...ctx, status: 400, code: "bad_request", path: err.path },
        "request rejected (cast error)",
      );
      res.status(400).json(envelope("bad_request", `invalid value for ${err.path}`));
      return;
    }
    if (err instanceof mongoose.Error.StrictModeError) {
      logger.warn(
        { ...ctx, status: 400, code: "bad_request", message: err.message },
        "request rejected (strict mode)",
      );
      res.status(400).json(envelope("bad_request", err.message));
      return;
    }
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: number }).code === 11000
    ) {
      logger.warn(
        {
          ...ctx,
          status: 409,
          code: "conflict",
          keyValue: (err as { keyValue?: unknown }).keyValue,
        },
        "request rejected (duplicate key)",
      );
      res
        .status(409)
        .json(envelope("conflict", "duplicate key", (err as { keyValue?: unknown }).keyValue));
      return;
    }
    logger.error({ error: err, ...ctx }, "unhandled error");
    res.status(500).json(envelope("internal", "internal error"));
  };
}
