import { Router } from "express";
import { z } from "zod";
import { queryLogs } from "../storage/logs.js";

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
