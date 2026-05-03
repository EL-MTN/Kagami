import { Router } from 'express';
import { z } from 'zod';
import { ingestSessionFromString } from '../ingest/sessions.js';
import { withVaultLock } from '../mutex.js';

const SessionBody = z.object({
  transcript: z.string().min(1),
  generate_summary: z.boolean().optional(),
});

export const sessionsRouter = Router();

sessionsRouter.post('/', async (req, res, next) => {
  try {
    const body = SessionBody.parse(req.body);
    const result = await withVaultLock(() =>
      ingestSessionFromString({
        transcript: body.transcript,
        generateSummary: body.generate_summary,
      }),
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
