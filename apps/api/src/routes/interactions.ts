import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { Interaction } from '../db/models/Interaction.js';
import { Person } from '../db/models/Person.js';
import {
  CHANNEL_VALUES,
  INTERACTION_STATUS,
  PARTICIPANT_ROLES,
} from '../db/models/Interaction.js';
import { SOURCE_VALUES } from '../db/models/base.js';
import { recordInteraction } from '../db/recordInteraction.js';
import { encodeCursor, decodeCursor } from '../lib/cursor.js';
import { errors } from '../lib/errors.js';
import { serializeInteraction } from '../lib/serialize.js';
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

const ParticipantInput = z
  .object({
    personId: ObjectIdString,
    role: z.enum(PARTICIPANT_ROLES),
  })
  .strict();

const AttachmentInput = z
  .object({
    name: z.string().min(1),
    mimeType: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
    ref: z.string().optional(),
  })
  .strict();

export const ParticipantResponse = z.object({
  personId: ObjectIdString,
  role: z.enum(PARTICIPANT_ROLES),
});

export const SourceRefResponse = z.object({
  provider: z.enum(['gmail', 'gcal']),
  id: z.string(),
});

export const AttachmentResponse = z.object({
  name: z.string(),
  mimeType: z.string().nullable(),
  size: z.number().nullable(),
  ref: z.string().nullable(),
});

export const InteractionResponseShape = z.object({
  id: ObjectIdString,
  occurredAt: ISODateString,
  channel: z.enum(CHANNEL_VALUES),
  title: z.string(),
  body: z.string(),
  sourceRef: SourceRefResponse.nullable(),
  participants: z.array(ParticipantResponse),
  location: z.string().nullable(),
  attachments: z.array(AttachmentResponse),
  context: z.array(z.string()),
  status: z.enum(INTERACTION_STATUS),
  source: z.enum(SOURCE_VALUES),
  sourceVersion: z.string().nullable(),
  deletedAt: ISODateString.nullable(),
  createdAt: ISODateString,
  updatedAt: ISODateString,
});

export const InteractionCreateBody = z
  .object({
    occurredAt: DateInput,
    channel: z.enum(CHANNEL_VALUES),
    title: z.string().min(1),
    body: z.string().optional(),
    participants: z.array(ParticipantInput).min(1),
    context: z.array(z.string()).optional(),
    location: z.string().optional(),
    attachments: z.array(AttachmentInput).optional(),
  })
  .strict();

export const ListInteractionsQuery = Pagination.extend({
  personId: ObjectIdString.optional(),
  orgId: ObjectIdString.optional(),
  context: z.string().optional(),
  channel: z.enum(CHANNEL_VALUES).optional(),
  occurredBefore: DateInput.optional(),
  occurredAfter: DateInput.optional(),
  query: z.string().optional(),
  status: z.enum([...INTERACTION_STATUS, 'any'] as const).default('active'),
  source: z.enum(SOURCE_VALUES).optional(),
  includeTombstoned: BoolFlag.optional(),
});

export type ListInteractionsQueryT = z.infer<typeof ListInteractionsQuery>;

export async function listInteractionsForFilter(q: ListInteractionsQueryT) {
  const filter: Record<string, unknown> = {};
  if (!q.includeTombstoned) filter.deletedAt = null;
  if (q.status !== 'any') filter.status = q.status;
  if (q.channel) filter.channel = q.channel;
  if (q.context) filter.context = q.context;
  if (q.source) filter.source = q.source;
  if (q.personId)
    filter['participants.personId'] = new Types.ObjectId(q.personId);
  if (q.orgId) {
    // Two-step join: people in org → interactions with those participants.
    const peopleIds = await Person.distinct('_id', {
      primaryOrgId: new Types.ObjectId(q.orgId),
      deletedAt: null,
    });
    filter['participants.personId'] = { $in: peopleIds };
  }
  if (q.occurredBefore || q.occurredAfter) {
    const range: Record<string, Date> = {};
    if (q.occurredBefore) range.$lt = new Date(q.occurredBefore);
    if (q.occurredAfter) range.$gt = new Date(q.occurredAfter);
    filter.occurredAt = range;
  }
  if (q.query) filter.$text = { $search: q.query };

  if (q.cursor) {
    const c = decodeCursor<{ id: string }>(q.cursor);
    filter._id = { $lt: new Types.ObjectId(c.id) };
  }

  const docs = await Interaction.find(filter)
    .sort({ _id: -1 })
    .limit(q.limit + 1)
    .lean();
  const hasMore = docs.length > q.limit;
  const page = hasMore ? docs.slice(0, -1) : docs;
  const items = page.map(serializeInteraction);
  const last = page[page.length - 1];
  const body: { items: unknown[]; nextCursor?: string } = { items };
  if (hasMore && last)
    body.nextCursor = encodeCursor({
      id: last._id.toHexString(),
    });
  return body;
}

export const interactionsRouter = Router();

interactionsRouter.get('/interactions', async (req, res) => {
  const q = ListInteractionsQuery.parse(req.query);
  const result = await listInteractionsForFilter(q);
  res.json(result);
});

interactionsRouter.post('/interactions', async (req, res) => {
  const body = InteractionCreateBody.parse(req.body);
  const created = await recordInteraction({
    occurredAt: new Date(body.occurredAt),
    channel: body.channel,
    title: body.title,
    body: body.body ?? '',
    participants: body.participants.map((p) => ({
      personId: new Types.ObjectId(p.personId),
      role: p.role,
    })),
    ...(body.context !== undefined ? { context: body.context } : {}),
    ...(body.location !== undefined ? { location: body.location } : {}),
    ...(body.attachments !== undefined ? { attachments: body.attachments } : {}),
    source: 'concierge',
  });
  // recordInteraction can only return null when skipIfDuplicate is set,
  // which the concierge write path doesn't pass.
  res.status(201).json(serializeInteraction(created!.toObject()));
});

interactionsRouter.delete('/interactions/:id', async (req, res) => {
  const { id } = IdParam.parse(req.params);
  const doc = await Interaction.findOneAndUpdate(
    { _id: id, deletedAt: null },
    { $set: { deletedAt: new Date() } },
    { new: true },
  ).lean();
  if (!doc) throw errors.notFound('interaction not found');
  res.status(200).json(serializeInteraction(doc));
});

export const interactionsEndpoints: EndpointSpec[] = [
  {
    name: 'list_interactions',
    method: 'GET',
    path: '/v1/interactions',
    description: 'List interactions with filter DSL + cursor pagination.',
    query: ListInteractionsQuery,
    response: ListResponse(InteractionResponseShape),
  },
  {
    name: 'log_interaction',
    method: 'POST',
    path: '/v1/interactions',
    description:
      'Insert an interaction; updates lastInteractionAt on each participant via $max.',
    body: InteractionCreateBody,
    response: InteractionResponseShape,
  },
  {
    name: 'tombstone_interaction',
    method: 'DELETE',
    path: '/v1/interactions/:id',
    description:
      'Soft-delete an interaction. Does NOT roll back lastInteractionAt.',
    params: IdParam,
    response: InteractionResponseShape,
  },
];
