import { Router } from "express";
import { z } from "zod";
import { listTraces, queryLogs, queryTrace } from "../storage/logs.js";
import { querySpansByTrace } from "../storage/spans.js";

export const queryRouter = Router();

// `level` accepts a single value or a comma-separated list (e.g.
// `?level=error,fatal`); the transform splits + trims + drops empties so a
// single value still resolves to a one-element array (queryLogs treats a
// 1-element array the same as a scalar).
const ListQuery = z.object({
  service: z.string().min(1).optional(),
  level: z
    .string()
    .min(1)
    .optional()
    .transform((v) =>
      v === undefined
        ? undefined
        : v
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
    ),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

queryRouter.get("/logs", async (req, res, next) => {
  try {
    const params = ListQuery.parse(req.query);
    const logs = await queryLogs(params);
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

const TraceListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  service: z.string().min(1).optional(),
});

queryRouter.get("/traces", async (req, res, next) => {
  try {
    const params = TraceListQuery.parse(req.query);
    const traces = await listTraces(params);
    res.json({ traces });
  } catch (err) {
    next(err);
  }
});

const TRACE_ID_RE = /^[0-9a-f]{32}$/i;

queryRouter.get("/traces/:id", async (req, res, next) => {
  try {
    const id = req.params.id ?? "";
    if (!TRACE_ID_RE.test(id)) {
      res.status(400).json({ error: "invalid_trace_id" });
      return;
    }
    const traceId = id.toLowerCase();
    const [logs, spans] = await Promise.all([queryTrace(traceId), querySpansByTrace(traceId)]);
    res.json({ traceId, logs, spans });
  } catch (err) {
    next(err);
  }
});
