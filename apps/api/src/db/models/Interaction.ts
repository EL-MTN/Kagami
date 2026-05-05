import { Schema, model } from "mongoose";
import { baseSchemaOptions, provenanceFields } from "./base.js";

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

const ParticipantSchema = new Schema(
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

const SourceRefSchema = new Schema(
  {
    provider: { type: String, required: true, enum: ["gmail", "gcal"] },
    id: { type: String, required: true },
  },
  { _id: false },
);

const AttachmentSchema = new Schema(
  {
    name: { type: String, required: true },
    mimeType: { type: String },
    size: { type: Number },
    ref: { type: String },
  },
  { _id: false },
);

const InteractionSchema = new Schema(
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

export const Interaction = model("Interaction", InteractionSchema);
export type InteractionDoc = ReturnType<(typeof Interaction)["hydrate"]>;
