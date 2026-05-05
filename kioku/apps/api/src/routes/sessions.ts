import { Router } from "express";
import { z } from "zod";
import { ingestSessionFromString } from "../ingest/sessions.js";

const SessionBody = z.object({
  transcript: z.string().min(1),
  generate_summary: z.boolean().optional(),
  user_id: z.string().optional(),
  run_id: z.string().optional(),
  agent_id: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const sessionsRouter = Router();

sessionsRouter.post("/", async (req, res, next) => {
  try {
    const body = SessionBody.parse(req.body);
    const result = await ingestSessionFromString({
      transcript: body.transcript,
      generateSummary: body.generate_summary,
      user_id: body.user_id,
      run_id: body.run_id,
      agent_id: body.agent_id,
      metadata: body.metadata,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
