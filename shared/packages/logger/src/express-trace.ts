import type { RequestHandler } from "express";
import {
  childSpan,
  formatTraceparent,
  newTraceContext,
  parseTraceparent,
  runWithTrace,
} from "./trace.js";

/**
 * Express middleware that establishes the request's trace context. If the
 * incoming request carries a W3C `traceparent` header, we treat its span as
 * the parent and open a child span; otherwise we mint a brand-new trace.
 *
 * The selected context is set as a response header so downstream tooling
 * (debug curls, browser devtools) can see what trace each response belongs
 * to, and the rest of the handler chain runs inside an AsyncLocalStorage
 * scope so the pino mixin picks it up on every log call.
 */
export function traceMiddleware(): RequestHandler {
  return (req, res, next) => {
    const incoming = parseTraceparent(req.header("traceparent"));
    const ctx = incoming ? childSpan(incoming) : newTraceContext();
    res.setHeader("traceparent", formatTraceparent(ctx));
    runWithTrace(ctx, () => {
      next();
    });
  };
}
