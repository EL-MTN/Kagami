import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { Followup } from "../db/models/Followup.js";
import { FOLLOWUP_DIRECTIONS, FOLLOWUP_STATUSES } from "../db/models/Followup.js";
import { SOURCE_VALUES } from "../db/models/base.js";
import { encodeCursor, decodeCursor } from "../lib/cursor.js";
import { errors } from "../lib/errors.js";
import { serializeFollowup } from "../lib/serialize.js";
import {
  BoolFlag,
  DateInput,
  IdParam,
  ISODateString,
  ListResponse,
  ObjectIdString,
  Pagination,
} from "../schemas/common.js";
import type { EndpointSpec } from "../manifest.js";

export const FollowupResponseShape = z.object({
  id: ObjectIdString,
  personId: ObjectIdString,
  direction: z.enum(FOLLOWUP_DIRECTIONS),
  dueAt: ISODateString.nullable(),
  status: z.enum(FOLLOWUP_STATUSES),
  reason: z.string(),
  sourceInteractionId: ObjectIdString.nullable(),
  source: z.enum(SOURCE_VALUES),
  sourceVersion: z.string().nullable(),
  deletedAt: ISODateString.nullable(),
  createdAt: ISODateString,
  updatedAt: ISODateString,
});

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
});

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
    const c = decodeCursor<{ id: string }>(q.cursor);
    filter._id = { $lt: new Types.ObjectId(c.id) };
  }

  const docs = await Followup.find(filter)
    .sort({ _id: -1 })
    .limit(q.limit + 1)
    .lean();
  const hasMore = docs.length > q.limit;
  const page = hasMore ? docs.slice(0, -1) : docs;
  const items = page.map(serializeFollowup);
  const last = page[page.length - 1];
  const body: { items: unknown[]; nextCursor?: string } = { items };
  if (hasMore && last)
    body.nextCursor = encodeCursor({
      id: last._id.toHexString(),
    });
  res.json(body);
});

followupsRouter.post("/followups", async (req, res) => {
  const body = FollowupCreateBody.parse(req.body);
  const doc = await Followup.create({
    personId: new Types.ObjectId(body.personId),
    direction: body.direction,
    reason: body.reason,
    ...(body.dueAt ? { dueAt: new Date(body.dueAt) } : {}),
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

export const followupsEndpoints: EndpointSpec[] = [
  {
    name: "list_followups",
    method: "GET",
    path: "/v1/followups",
    description: "List followups (default status=open).",
    query: ListFollowupsQuery,
    response: ListResponse(FollowupResponseShape),
  },
  {
    name: "create_followup",
    method: "POST",
    path: "/v1/followups",
    description: "Create a followup. Mashiro sets direction.",
    body: FollowupCreateBody,
    response: FollowupResponseShape,
  },
  {
    name: "update_followup",
    method: "PATCH",
    path: "/v1/followups/:id",
    description: "Update a followup status (complete/snooze/dismiss).",
    params: IdParam,
    body: FollowupUpdateBody,
    response: FollowupResponseShape,
  },
  {
    name: "tombstone_followup",
    method: "DELETE",
    path: "/v1/followups/:id",
    description: "Soft-delete a followup.",
    params: IdParam,
    response: FollowupResponseShape,
  },
];
