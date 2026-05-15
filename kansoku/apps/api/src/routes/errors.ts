import { Router } from "express";
import { z } from "zod";
import { listErrors } from "../storage/errors.js";

export const errorsRouter = Router();

const ListQuery = z.object({
  service: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

errorsRouter.get("/errors", async (req, res, next) => {
  try {
    const params = ListQuery.parse(req.query);
    const errors = await listErrors(params);
    res.json({ errors });
  } catch (err) {
    next(err);
  }
});
