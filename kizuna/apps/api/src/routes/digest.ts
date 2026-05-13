import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { Followup } from "../db/models/Followup.js";
import { Person } from "../db/models/Person.js";
import { parseDurationMs } from "../lib/duration.js";
import { errors } from "../lib/errors.js";
import { serializeFollowup } from "../lib/serialize.js";

const DigestQuery = z.object({
  window: z.string().default("P7D"),
});

export const digestRouter = Router();

digestRouter.get("/digest", async (req, res) => {
  const q = DigestQuery.parse(req.query);
  let windowMs: number;
  try {
    windowMs = parseDurationMs(q.window);
  } catch (err) {
    throw errors.badRequest(err instanceof Error ? err.message : "invalid window");
  }

  const now = new Date();
  const windowEnd = new Date(now.getTime() + windowMs);

  const [overdue, upcoming] = await Promise.all([
    Followup.find({
      status: "open",
      deletedAt: null,
      dueAt: { $lt: now },
    })
      .sort({ dueAt: 1, _id: 1 })
      .lean(),
    Followup.find({
      status: "open",
      deletedAt: null,
      dueAt: { $gte: now, $lte: windowEnd },
    })
      .sort({ dueAt: 1, _id: 1 })
      .lean(),
  ]);

  const personIds = new Set<string>();
  for (const f of [...overdue, ...upcoming]) {
    const pid = f.personId;
    if (pid) personIds.add(pid.toHexString());
  }
  const persons = (await Person.find({
    _id: { $in: [...personIds].map((s) => new Types.ObjectId(s)) },
    deletedAt: null,
  }).lean()) as unknown as Array<{
    _id: Types.ObjectId;
    displayName: string;
    primaryEmail: string | null;
  }>;
  const personById = new Map<
    string,
    { id: string; displayName: string; primaryEmail: string | null }
  >();
  for (const p of persons) {
    personById.set(p._id.toHexString(), {
      id: p._id.toHexString(),
      displayName: p.displayName,
      primaryEmail: p.primaryEmail ?? null,
    });
  }

  const hydrate = (
    f: Record<string, unknown>,
  ): Record<string, unknown> & {
    person: { id: string; displayName: string; primaryEmail: string | null } | null;
  } => {
    const base = serializeFollowup(f);
    const pid = (f.personId as Types.ObjectId | null)?.toHexString() ?? null;
    return {
      ...(base as Record<string, unknown>),
      person: pid ? (personById.get(pid) ?? null) : null,
    };
  };

  res.json({
    window: q.window,
    generatedAt: now,
    windowStart: now,
    windowEnd,
    overdue: overdue.map(hydrate),
    upcoming: upcoming.map(hydrate),
  });
});
