import { Schema, Types, model, type HydratedDocument } from "mongoose";
import { baseSchemaOptions, provenanceFields, type Source } from "./base.js";

export const CHANNEL_VALUES = [
  "email",
  "calendar",
  "in_person",
  "call",
  "message",
  "manual",
] as const;

export const PARTICIPANT_ROLES = ["from", "to", "cc", "attendee", "subject"] as const;

export const INTERACTION_STATUS = ["active", "cancelled"] as const;

export type InteractionChannel = (typeof CHANNEL_VALUES)[number];
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];
export type InteractionStatus = (typeof INTERACTION_STATUS)[number];

export type InteractionParticipant = {
  personId: Types.ObjectId;
  role: ParticipantRole;
};

export type InteractionSourceRef = {
  provider: "gmail" | "gcal";
  id: string;
};

export type InteractionAttachment = {
  name: string;
  mimeType?: string;
  size?: number;
  ref?: string;
};

export type InteractionAttrs = {
  occurredAt: Date;
  channel: InteractionChannel;
  title: string;
  body: string;
  sourceRef: InteractionSourceRef | null;
  participants: InteractionParticipant[];
  location?: string;
  attachments: InteractionAttachment[];
  context: string[];
  status: InteractionStatus;
  source: Source;
  sourceVersion?: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const ParticipantSchema = new Schema<InteractionParticipant>(
  {
    personId: {
      type: Schema.Types.ObjectId,
      ref: "Person",
      required: true,
    },
    role: { type: String, required: true, enum: PARTICIPANT_ROLES },
  },
  { _id: false },
);

const SourceRefSchema = new Schema<InteractionSourceRef>(
  {
    provider: { type: String, required: true, enum: ["gmail", "gcal"] },
    id: { type: String, required: true },
  },
  { _id: false },
);

const AttachmentSchema = new Schema<InteractionAttachment>(
  {
    name: { type: String, required: true },
    mimeType: { type: String },
    size: { type: Number },
    ref: { type: String },
  },
  { _id: false },
);

const InteractionSchema = new Schema<InteractionAttrs>(
  {
    occurredAt: { type: Date, required: true },
    channel: { type: String, required: true, enum: CHANNEL_VALUES },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    sourceRef: { type: SourceRefSchema, default: null },
    participants: {
      type: [ParticipantSchema],
      validate: {
        validator: (v: unknown[]) => Array.isArray(v) && v.length >= 1,
        message: "at least one participant is required",
      },
    },
    location: { type: String },
    attachments: { type: [AttachmentSchema], default: [] },
    context: { type: [String], default: [] },
    status: { type: String, enum: INTERACTION_STATUS, default: "active" },
    ...provenanceFields,
  },
  baseSchemaOptions,
);

InteractionSchema.index({ occurredAt: -1 });
InteractionSchema.index({ "participants.personId": 1, occurredAt: -1 });
InteractionSchema.index(
  { "sourceRef.provider": 1, "sourceRef.id": 1 },
  {
    unique: true,
    partialFilterExpression: { "sourceRef.id": { $type: "string" } },
    name: "interactions_sourceRef_unique",
  },
);
InteractionSchema.index({ context: 1, occurredAt: -1 });
InteractionSchema.index({ title: "text", body: "text" }, { name: "interactions_text" });
InteractionSchema.index({ deletedAt: 1 }, { sparse: true });

export const Interaction = model<InteractionAttrs>("Interaction", InteractionSchema);
export type InteractionDoc = HydratedDocument<InteractionAttrs>;
