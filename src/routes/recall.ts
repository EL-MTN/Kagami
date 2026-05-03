import { Router } from 'express';
import { z } from 'zod';
import { recall } from '../query/recall.js';

const RecallBody = z.object({
  query: z.string().min(1),
  k: z.number().int().positive().max(100).optional(),
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'since must be YYYY-MM-DD')
    .optional(),
  until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'until must be YYYY-MM-DD')
    .optional(),
});

export const recallRouter = Router();

recallRouter.post('/', async (req, res, next) => {
  try {
    const body = RecallBody.parse(req.body);
    const facts = await recall(body.query, {
      k: body.k,
      since: body.since,
      until: body.until,
    });
    res.json({ facts, total: facts.length });
  } catch (err) {
    next(err);
  }
});
