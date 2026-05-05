import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { Organization } from "../db/models/Organization.js";
import { SOURCE_VALUES } from "../db/models/base.js";
import { encodeCursor, decodeCursor } from "../lib/cursor.js";
import { errors } from "../lib/errors.js";
import { serializeOrganization } from "../lib/serialize.js";
import {
  BoolFlag,
  IdParam,
  ISODateString,
  ListResponse,
  ObjectIdString,
  Pagination,
} from "../schemas/common.js";
import type { EndpointSpec } from "../manifest.js";

export const OrganizationResponseShape = z.object({
  id: ObjectIdString,
  name: z.string(),
  domain: z.string().nullable(),
  website: z.string().nullable(),
  industry: z.string().nullable(),
  notes: z.string().nullable(),
  source: z.enum(SOURCE_VALUES),
  sourceVersion: z.string().nullable(),
  deletedAt: ISODateString.nullable(),
  createdAt: ISODateString,
  updatedAt: ISODateString,
});

export const OrganizationCreateBody = z
  .object({
    name: z.string().min(1),
    domain: z.string().toLowerCase().optional(),
    website: z.string().optional(),
    industry: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict();

export const OrganizationUpdateBody = OrganizationCreateBody.partial().strict();

export const ListOrganizationsQuery = Pagination.extend({
  query: z.string().optional(),
  domain: z.string().toLowerCase().optional(),
  source: z.enum(SOURCE_VALUES).optional(),
  includeTombstoned: BoolFlag.optional(),
});

export const organizationsRouter = Router();

organizationsRouter.get("/organizations", async (req, res) => {
  const q = ListOrganizationsQuery.parse(req.query);
  const filter: Record<string, unknown> = {};
  if (!q.includeTombstoned) filter.deletedAt = null;
  if (q.domain) filter.domain = q.domain;
  if (q.source) filter.source = q.source;
  if (q.query) filter.name = { $regex: escapeRegex(q.query), $options: "i" };
  if (q.cursor) {
    const c = decodeCursor<{ id: string }>(q.cursor);
    filter._id = { $lt: new Types.ObjectId(c.id) };
  }

  const docs = await Organization.find(filter)
    .sort({ _id: -1 })
    .limit(q.limit + 1)
    .lean();
  const hasMore = docs.length > q.limit;
  const page = hasMore ? docs.slice(0, -1) : docs;
  const items = page.map(serializeOrganization);
  const last = page[page.length - 1];
  const body: { items: unknown[]; nextCursor?: string } = { items };
  if (hasMore && last)
    body.nextCursor = encodeCursor({
      id: last._id.toHexString(),
    });
  res.json(body);
});

organizationsRouter.get("/organizations/:id", async (req, res) => {
  const { id } = IdParam.parse(req.params);
  const doc = await Organization.findOne({ _id: id, deletedAt: null }).lean();
  if (!doc) throw errors.notFound("organization not found");
  res.json(serializeOrganization(doc));
});

organizationsRouter.post("/organizations", async (req, res) => {
  const body = OrganizationCreateBody.parse(req.body);
  const doc = await Organization.create({ ...body, source: "concierge" });
  res.status(201).json(serializeOrganization(doc.toObject()));
});

organizationsRouter.patch("/organizations/:id", async (req, res) => {
  const { id } = IdParam.parse(req.params);
  const body = OrganizationUpdateBody.parse(req.body);
  const doc = await Organization.findOneAndUpdate(
    { _id: id, deletedAt: null },
    { $set: body },
    { new: true, runValidators: true },
  ).lean();
  if (!doc) throw errors.notFound("organization not found");
  res.json(serializeOrganization(doc));
});

organizationsRouter.delete("/organizations/:id", async (req, res) => {
  const { id } = IdParam.parse(req.params);
  const doc = await Organization.findOneAndUpdate(
    { _id: id, deletedAt: null },
    { $set: { deletedAt: new Date() } },
    { new: true },
  ).lean();
  if (!doc) throw errors.notFound("organization not found");
  res.status(200).json(serializeOrganization(doc));
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const organizationsEndpoints: EndpointSpec[] = [
  {
    name: "find_organizations",
    method: "GET",
    path: "/v1/organizations",
    description: "List organizations.",
    query: ListOrganizationsQuery,
    response: ListResponse(OrganizationResponseShape),
  },
  {
    name: "get_organization",
    method: "GET",
    path: "/v1/organizations/:id",
    description: "Fetch one organization by id (live rows only).",
    params: IdParam,
    response: OrganizationResponseShape,
  },
  {
    name: "add_organization",
    method: "POST",
    path: "/v1/organizations",
    description: "Create an organization.",
    body: OrganizationCreateBody,
    response: OrganizationResponseShape,
  },
  {
    name: "update_organization",
    method: "PATCH",
    path: "/v1/organizations/:id",
    description: "Patch an organization.",
    params: IdParam,
    body: OrganizationUpdateBody,
    response: OrganizationResponseShape,
  },
  {
    name: "tombstone_organization",
    method: "DELETE",
    path: "/v1/organizations/:id",
    description: "Soft-delete an organization.",
    params: IdParam,
    response: OrganizationResponseShape,
  },
];
