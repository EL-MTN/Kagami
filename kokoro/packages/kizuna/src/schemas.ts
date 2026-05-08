import { z } from "zod";

export const ObjectIdString = z.string().regex(/^[a-f0-9]{24}$/i);
export const ISODateString = z.string().datetime({ offset: true });

export const ListEnvelopeSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().optional(),
  });

export const PersonWireSchema = z.object({
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
  source: z.string(),
  sourceVersion: z.string().nullable(),
  deletedAt: ISODateString.nullable(),
  createdAt: ISODateString,
  updatedAt: ISODateString,
});

export const InteractionWireSchema = z.object({
  id: ObjectIdString,
  occurredAt: ISODateString,
  channel: z.enum(["email", "calendar", "call", "in_person", "message", "manual"]),
  title: z.string(),
  body: z.string(),
  sourceRef: z
    .object({
      provider: z.enum(["gmail", "gcal"]),
      id: z.string(),
    })
    .nullable(),
  participants: z.array(
    z.object({
      personId: ObjectIdString,
      role: z.enum(["from", "to", "cc", "attendee", "subject"]),
    }),
  ),
  location: z.string().nullable(),
  attachments: z.array(
    z.object({
      name: z.string(),
      mimeType: z.string().nullable(),
      size: z.number().nullable(),
      ref: z.string().nullable(),
    }),
  ),
  context: z.array(z.string()),
  status: z.enum(["active", "cancelled"]),
  source: z.string(),
  sourceVersion: z.string().nullable(),
  deletedAt: ISODateString.nullable(),
  createdAt: ISODateString,
  updatedAt: ISODateString,
});

export const FollowupWireSchema = z.object({
  id: ObjectIdString,
  personId: ObjectIdString,
  direction: z.enum(["i_owe", "they_owe"]),
  dueAt: ISODateString.nullable(),
  status: z.enum(["open", "done", "snoozed", "dismissed"]),
  reason: z.string(),
  sourceInteractionId: ObjectIdString.nullable(),
  source: z.string(),
  sourceVersion: z.string().nullable(),
  deletedAt: ISODateString.nullable(),
  createdAt: ISODateString,
  updatedAt: ISODateString,
});

export const PeopleEnvelopeSchema = ListEnvelopeSchema(PersonWireSchema);
export const InteractionsEnvelopeSchema = ListEnvelopeSchema(InteractionWireSchema);
export const FollowupsEnvelopeSchema = ListEnvelopeSchema(FollowupWireSchema);

export type ListEnvelope<T> = {
  items: T[];
  nextCursor?: string;
};

export type PersonWire = z.infer<typeof PersonWireSchema>;
export type InteractionWire = z.infer<typeof InteractionWireSchema>;
export type FollowupWire = z.infer<typeof FollowupWireSchema>;

export type PersonSummary = {
  id: string;
  displayName: string;
  primaryEmail: string | null;
  primaryOrgId: string | null;
  tags: string[];
  lastInteractionAt: string | null;
};

export type PersonContextSummary = PersonSummary & {
  relationshipExcerpt: string | null;
  relationshipTruncated: boolean;
  emails: string[];
  phones: string[];
  handles: Record<string, string>;
  birthday: string | null;
  notesExcerpt: string | null;
  notesTruncated: boolean;
};

export type InteractionSummary = {
  id: string;
  occurredAt: string;
  channel: InteractionWire["channel"];
  title: string;
  bodyExcerpt: string | null;
  bodyTruncated: boolean;
  participants: InteractionWire["participants"];
  context: string[];
  status: InteractionWire["status"];
};

export type FollowupSummary = {
  id: string;
  person: PersonSummary;
  direction: FollowupWire["direction"];
  dueAt: string | null;
  status: FollowupWire["status"];
  reasonExcerpt: string;
  reasonTruncated: boolean;
  sourceInteractionId: string | null;
};

export type PersonContext = {
  person: PersonContextSummary;
  recentInteractions: InteractionSummary[];
  openFollowups: FollowupSummary[];
  pagination: {
    recentInteractions: { truncated: boolean };
    openFollowups: { truncated: boolean };
  };
  lastInteractionAt: string | null;
};
