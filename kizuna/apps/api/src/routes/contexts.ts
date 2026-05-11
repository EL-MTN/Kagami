import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { Interaction } from "../db/models/Interaction.js";
import { ObjectIdString } from "../schemas/common.js";

export const ListContextsQuery = z.object({
  personId: ObjectIdString.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export const contextsRouter = Router();

contextsRouter.get("/contexts", async (req, res) => {
  const q = ListContextsQuery.parse(req.query);
  const match: Record<string, unknown> = {
    deletedAt: null,
    status: "active",
    context: { $exists: true, $ne: [] },
  };
  if (q.personId) {
    match["participants.personId"] = new Types.ObjectId(q.personId);
  }
  const rows = await Interaction.aggregate<{ _id: string; count: number }>([
    { $match: match },
    { $unwind: "$context" },
    { $group: { _id: "$context", count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: q.limit },
  ]);
  res.json({
    items: rows.map((r) => ({ tag: r._id, count: r.count })),
  });
});
