import { Router } from "express";
import { z } from "zod";
import { queryLogs, queryTrace } from "../storage/logs.js";

export const queryRouter = Router();

const ListQuery = z.object({
  service: z.string().min(1).optional(),
  level: z.string().min(1).optional(),
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

const TRACE_ID_RE = /^[0-9a-f]{32}$/i;

queryRouter.get("/traces/:id", async (req, res, next) => {
  try {
    const id = req.params.id ?? "";
    if (!TRACE_ID_RE.test(id)) {
      res.status(400).json({ error: "invalid_trace_id" });
      return;
    }
    const logs = await queryTrace(id.toLowerCase());
    res.json({ traceId: id.toLowerCase(), logs });
  } catch (err) {
    next(err);
  }
});
