import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { Followup } from "../db/models/Followup.js";
import { FOLLOWUP_DIRECTIONS, FOLLOWUP_STATUSES } from "../db/models/Followup.js";
import { encodeCursor, decodeCursor } from "../lib/cursor.js";
import { errors } from "../lib/errors.js";
import { appendAnd } from "../lib/query.js";
import { serializeFollowup } from "../lib/serialize.js";
import { BoolFlag, DateInput, IdParam, ObjectIdString, Pagination } from "../schemas/common.js";

export const FollowupCreateBody = z
  .object({
    personId: ObjectIdString,
    direction: z.enum(FOLLOWUP_DIRECTIONS),
    reason: z.string().min(1),
    dueAt: DateInput.optional(),
    sourceInteractionId: ObjectIdString.optional(),
  })
  .strict();

export const FollowupUpdateBody = z
  .object({
    status: z.enum(FOLLOWUP_STATUSES),
    dueAt: DateInput.optional(),
    reason: z.string().optional(),
  })
  .strict();

export const ListFollowupsQuery = Pagination.extend({
  personId: ObjectIdString.optional(),
  direction: z.enum(FOLLOWUP_DIRECTIONS).optional(),
  status: z.enum(FOLLOWUP_STATUSES).default("open"),
  dueBefore: DateInput.optional(),
  dueAfter: DateInput.optional(),
  includeTombstoned: BoolFlag.optional(),
  sort: z.enum(["_id:-1", "duePriority:1"]).default("_id:-1"),
});

type DuePriorityCursor = { dp: 0 | 1; due: string | null; id: string };
type LeanFollowup = {
  _id: Types.ObjectId;
  dueAt?: Date | string | null;
  duePriorityBucket?: number | null;
};

function validateDuePriorityCursor(cursor: string): DuePriorityCursor {
  const c = decodeCursor<DuePriorityCursor>(cursor);
  if (
    (c.dp !== 0 && c.dp !== 1) ||
    typeof c.id !== "string" ||
    !Types.ObjectId.isValid(c.id) ||
    !(c.due === null || typeof c.due === "string")
  ) {
    throw errors.badRequest("invalid cursor");
  }
  if (c.dp === 0 && (typeof c.due !== "string" || Number.isNaN(new Date(c.due).getTime()))) {
    throw errors.badRequest("invalid cursor");
  }
  if (c.dp === 1 && c.due !== null) {
    throw errors.badRequest("invalid cursor");
  }
  return c;
}

function dueIso(value: LeanFollowup["dueAt"]): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export const followupsRouter = Router();

followupsRouter.get("/followups", async (req, res) => {
  const q = ListFollowupsQuery.parse(req.query);
  const filter: Record<string, unknown> = { status: q.status };
  if (!q.includeTombstoned) filter.deletedAt = null;
  if (q.personId) filter.personId = new Types.ObjectId(q.personId);
  if (q.direction) filter.direction = q.direction;
  if (q.dueBefore || q.dueAfter) {
    const range: Record<string, Date> = {};
    if (q.dueBefore) range.$lt = new Date(q.dueBefore);
    if (q.dueAfter) range.$gt = new Date(q.dueAfter);
    filter.dueAt = range;
  }
  if (q.cursor) {
    if (q.sort === "duePriority:1") {
      const c = validateDuePriorityCursor(q.cursor);
      const cId = new Types.ObjectId(c.id);
      if (c.dp === 0) {
        if (c.due === null) throw errors.badRequest("invalid cursor");
        const cDate = new Date(c.due);
        appendAnd(filter, {
          $or: [
            { duePriorityBucket: 0, dueAt: { $gt: cDate } },
            { duePriorityBucket: 0, dueAt: cDate, _id: { $lt: cId } },
            { duePriorityBucket: 1 },
          ],
        });
      } else {
        appendAnd(filter, { duePriorityBucket: 1, _id: { $lt: cId } });
      }
    } else {
      const c = decodeCursor<{ id: string }>(q.cursor);
      filter._id = { $lt: new Types.ObjectId(c.id) };
    }
  }

  const sort: Record<string, 1 | -1> =
    q.sort === "duePriority:1" ? { duePriorityBucket: 1, dueAt: 1, _id: -1 } : { _id: -1 };

  const docs = await Followup.find(filter)
    .sort(sort)
    .limit(q.limit + 1)
    .lean();
  const hasMore = docs.length > q.limit;
  const page = hasMore ? docs.slice(0, -1) : docs;
  const items = page.map(serializeFollowup);
  const last = page[page.length - 1] as LeanFollowup | undefined;
  const body: { items: unknown[]; nextCursor?: string } = { items };
  if (hasMore && last) {
    const dp = last.duePriorityBucket === 0 ? 0 : 1;
    body.nextCursor =
      q.sort === "duePriority:1"
        ? encodeCursor({
            dp,
            due: dp === 0 ? dueIso(last.dueAt) : null,
            id: last._id.toHexString(),
          })
        : encodeCursor({
            id: last._id.toHexString(),
          });
  }
  res.json(body);
});

followupsRouter.post("/followups", async (req, res) => {
  const body = FollowupCreateBody.parse(req.body);
  const doc = await Followup.create({
    personId: new Types.ObjectId(body.personId),
    direction: body.direction,
    reason: body.reason,
    ...(body.dueAt
      ? { dueAt: new Date(body.dueAt), duePriorityBucket: 0 }
      : { duePriorityBucket: 1 }),
    ...(body.sourceInteractionId
      ? { sourceInteractionId: new Types.ObjectId(body.sourceInteractionId) }
      : {}),
    source: "concierge",
  });
  res.status(201).json(serializeFollowup(doc.toObject()));
});

followupsRouter.patch("/followups/:id", async (req, res) => {
  const { id } = IdParam.parse(req.params);
  const body = FollowupUpdateBody.parse(req.body);
  const update: Record<string, unknown> = { status: body.status };
  if (body.dueAt) update.dueAt = new Date(body.dueAt);
  if (body.dueAt) update.duePriorityBucket = 0;
  if (body.reason !== undefined) update.reason = body.reason;

  const doc = await Followup.findOneAndUpdate(
    { _id: id, deletedAt: null },
    { $set: update },
    { new: true, runValidators: true },
  ).lean();
  if (!doc) throw errors.notFound("followup not found");
  res.json(serializeFollowup(doc));
});

followupsRouter.delete("/followups/:id", async (req, res) => {
  const { id } = IdParam.parse(req.params);
  const doc = await Followup.findOneAndUpdate(
    { _id: id, deletedAt: null },
    { $set: { deletedAt: new Date() } },
    { new: true },
  ).lean();
  if (!doc) throw errors.notFound("followup not found");
  res.status(200).json(serializeFollowup(doc));
});
