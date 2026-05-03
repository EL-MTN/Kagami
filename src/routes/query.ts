import { Router } from 'express';
import { z } from 'zod';
import { query } from '../query/answer.js';

const QueryBody = z.object({
  question: z.string().min(1),
  k: z.number().int().positive().max(100).optional(),
});

export const queryRouter = Router();

queryRouter.post('/', async (req, res, next) => {
  try {
    const body = QueryBody.parse(req.body);
    const result = await query(body.question, { topK: body.k });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
