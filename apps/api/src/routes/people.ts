import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { Followup } from '../db/models/Followup.js';
import { Person } from '../db/models/Person.js';
import { SOURCE_VALUES } from '../db/models/base.js';
import { encodeCursor, decodeCursor } from '../lib/cursor.js';
import { errors } from '../lib/errors.js';
import { serializePerson } from '../lib/serialize.js';
import {
  BoolFlag,
  DateInput,
  IdParam,
  ISODateString,
  ListResponse,
  ObjectIdString,
  Pagination,
} from '../schemas/common.js';
import type { EndpointSpec } from '../manifest.js';
import {
  ListInteractionsQuery,
  listInteractionsForFilter,
  InteractionResponseShape,
} from './interactions.js';

const Birthday = z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  z.string().regex(/^--\d{2}-\d{2}$/),
]);

const HandlesInput = z.record(z.string(), z.string());

export const PersonResponseShape = z.object({
  id: ObjectIdString,
  displayName: z.string(),
  primaryEmail: z.string().nullable(),
  primaryOrgId: ObjectIdString.nullable(),
  relationship: z.string().nullable(),
  firstSeen: ISODateString.nullable(),
  lastInteractionAt: ISODateString.nullable(),
  emails: z.array(z.string()),
  phones: z.array(z.string()),
  handles: z.record(z.string(), z.string()),
  tags: z.array(z.string()),
  birthday: z.string().nullable(),
  notes: z.string().nullable(),
  suppressReingest: z.boolean(),
  source: z.enum(SOURCE_VALUES),
  sourceVersion: z.string().nullable(),
  deletedAt: ISODateString.nullable(),
  createdAt: ISODateString,
  updatedAt: ISODateString,
});

export const PersonCreateBody = z
  .object({
    displayName: z.string().min(1),
    primaryEmail: z.string().email().toLowerCase().optional(),
    primaryOrgId: ObjectIdString.optional(),
    relationship: z.string().optional(),
    emails: z.array(z.string().email().toLowerCase()).optional(),
    phones: z.array(z.string()).optional(),
    handles: HandlesInput.optional(),
    tags: z.array(z.string()).optional(),
    birthday: Birthday.optional(),
    notes: z.string().optional(),
  })
  .strict();

export const PersonUpdateBody = PersonCreateBody.partial().strict();

export const ListPeopleQuery = Pagination.extend({
  query: z.string().optional(),
  orgId: ObjectIdString.optional(),
  tag: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) =>
      v === undefined ? undefined : Array.isArray(v) ? v : [v],
    ),
  lastInteractionBefore: DateInput.optional(),
  lastInteractionAfter: DateInput.optional(),
  hasOpenFollowup: BoolFlag.optional(),
  source: z.enum(SOURCE_VALUES).optional(),
  includeTombstoned: BoolFlag.optional(),
  sort: z.enum(['_id:-1', 'lastInteractionAt:-1']).default('_id:-1'),
});

type LiaCursor = { lia: string | null; id: string };
type IdCursor = { id: string };

export const peopleRouter = Router();

peopleRouter.get('/people', async (req, res) => {
  const q = ListPeopleQuery.parse(req.query);
  const filter: Record<string, unknown> = {};
  if (!q.includeTombstoned) filter.deletedAt = null;
  if (q.orgId) filter.primaryOrgId = new Types.ObjectId(q.orgId);
  if (q.tag) filter.tags = { $all: q.tag };
  if (q.source) filter.source = q.source;
  if (q.lastInteractionBefore || q.lastInteractionAfter) {
    const range: Record<string, Date> = {};
    if (q.lastInteractionBefore) range.$lt = new Date(q.lastInteractionBefore);
    if (q.lastInteractionAfter) range.$gt = new Date(q.lastInteractionAfter);
    filter.lastInteractionAt = range;
  }
  if (q.query) filter.$text = { $search: q.query };

  if (q.hasOpenFollowup !== undefined) {
    const openIds = await Followup.distinct('personId', {
      status: 'open',
      deletedAt: null,
    });
    filter._id = q.hasOpenFollowup ? { $in: openIds } : { $nin: openIds };
  }

  // Sort + cursor. Two modes:
  //   _id:-1                 — simple cursor: {id}
  //   lastInteractionAt:-1   — compound cursor: {lia, id}, null bucket comes last
  const sort: Record<string, 1 | -1> =
    q.sort === 'lastInteractionAt:-1'
      ? { lastInteractionAt: -1, _id: -1 }
      : { _id: -1 };

  if (q.cursor) {
    if (q.sort === 'lastInteractionAt:-1') {
      const c = decodeCursor<LiaCursor>(q.cursor);
      const cId = new Types.ObjectId(c.id);
      if (c.lia === null) {
        // Already in the trailing null bucket — only nulls remain.
        filter.lastInteractionAt = null;
        filter._id = { ...((filter._id as object) ?? {}), $lt: cId };
      } else {
        const cDate = new Date(c.lia);
        const cursorBranches: Record<string, unknown>[] = [
          { lastInteractionAt: { $lt: cDate } },
          { lastInteractionAt: cDate, _id: { $lt: cId } },
          { lastInteractionAt: null },
        ];
        filter.$and = [
          ...((filter.$and as Array<Record<string, unknown>>) ?? []),
          { $or: cursorBranches },
        ];
      }
    } else {
      const c = decodeCursor<IdCursor>(q.cursor);
      filter._id = {
        ...((filter._id as object) ?? {}),
        $lt: new Types.ObjectId(c.id),
      };
    }
  }

  const docs = await Person.find(filter).sort(sort).limit(q.limit + 1).lean();
  const hasMore = docs.length > q.limit;
  const page = hasMore ? docs.slice(0, -1) : docs;
  const items = page.map(serializePerson);
  const last = page[page.length - 1] as
    | { _id: Types.ObjectId; lastInteractionAt?: Date | null }
    | undefined;
  const body: { items: unknown[]; nextCursor?: string } = { items };
  if (hasMore && last) {
    if (q.sort === 'lastInteractionAt:-1') {
      const lia =
        last.lastInteractionAt instanceof Date
          ? last.lastInteractionAt.toISOString()
          : null;
      body.nextCursor = encodeCursor({ lia, id: last._id.toHexString() });
    } else {
      body.nextCursor = encodeCursor({ id: last._id.toHexString() });
    }
  }
  res.json(body);
});

peopleRouter.get('/people/:id', async (req, res) => {
  const { id } = IdParam.parse(req.params);
  const doc = await Person.findOne({ _id: id, deletedAt: null }).lean();
  if (!doc) throw errors.notFound('person not found');
  res.json(serializePerson(doc));
});

peopleRouter.post('/people', async (req, res) => {
  const body = PersonCreateBody.parse(req.body);
  const doc = await Person.create({
    ...body,
    firstSeen: new Date(),
    source: 'concierge',
  });
  res.status(201).json(serializePerson(doc.toObject()));
});

peopleRouter.patch('/people/:id', async (req, res) => {
  const { id } = IdParam.parse(req.params);
  const body = PersonUpdateBody.parse(req.body);
  const doc = await Person.findOneAndUpdate(
    { _id: id, deletedAt: null },
    { $set: body },
    { new: true, runValidators: true },
  ).lean();
  if (!doc) throw errors.notFound('person not found');
  res.json(serializePerson(doc));
});

peopleRouter.delete('/people/:id', async (req, res) => {
  const { id } = IdParam.parse(req.params);
  const doc = await Person.findOneAndUpdate(
    { _id: id, deletedAt: null },
    { $set: { deletedAt: new Date(), suppressReingest: true } },
    { new: true },
  ).lean();
  if (!doc) throw errors.notFound('person not found');
  res.status(200).json(serializePerson(doc));
});

peopleRouter.get('/people/:id/interactions', async (req, res) => {
  const { id } = IdParam.parse(req.params);
  // Reuse the interactions list filter, but pin personId.
  const q = ListInteractionsQuery.parse({ ...req.query, personId: id });
  const result = await listInteractionsForFilter(q);
  res.json(result);
});

export const peopleEndpoints: EndpointSpec[] = [
  {
    name: 'find_people',
    method: 'GET',
    path: '/v1/people',
    description: 'List people, with filter DSL + cursor pagination.',
    query: ListPeopleQuery,
    response: ListResponse(PersonResponseShape),
  },
  {
    name: 'get_person',
    method: 'GET',
    path: '/v1/people/:id',
    description: 'Fetch one person by id (live rows only).',
    params: IdParam,
    response: PersonResponseShape,
  },
  {
    name: 'add_person',
    method: 'POST',
    path: '/v1/people',
    description: 'Create a person (concierge-sourced).',
    body: PersonCreateBody,
    response: PersonResponseShape,
  },
  {
    name: 'update_person',
    method: 'PATCH',
    path: '/v1/people/:id',
    description: 'Patch a person; firstSeen + lastInteractionAt are not settable.',
    params: IdParam,
    body: PersonUpdateBody,
    response: PersonResponseShape,
  },
  {
    name: 'tombstone_person',
    method: 'DELETE',
    path: '/v1/people/:id',
    description: 'Soft-delete a person; sets suppressReingest=true.',
    params: IdParam,
    response: PersonResponseShape,
  },
  {
    name: 'get_interactions_for',
    method: 'GET',
    path: '/v1/people/:id/interactions',
    description: 'List interactions where the person is a participant.',
    params: IdParam,
    query: ListInteractionsQuery,
    response: ListResponse(InteractionResponseShape),
  },
];
