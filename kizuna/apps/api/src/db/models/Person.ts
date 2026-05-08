import { Schema, model } from "mongoose";
import { baseSchemaOptions, provenanceFields } from "./base.js";

const PersonSchema = new Schema(
  {
    displayName: { type: String, required: true },
    primaryEmail: {
      type: String,
      lowercase: true,
      trim: true,
      default: null,
    },
    primaryOrgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
    },
    relationship: { type: String },
    firstSeen: { type: Date },
    lastInteractionAt: { type: Date },
    emails: { type: [String], default: [] },
    phones: { type: [String], default: [] },
    handles: { type: Map, of: String, default: () => new Map<string, string>() },
    tags: { type: [String], default: [] },
    birthday: { type: String },
    notes: { type: String },
    suppressReingest: { type: Boolean, default: false },
    ...provenanceFields,
  },
  baseSchemaOptions,
);

PersonSchema.index({ primaryEmail: 1 }, { sparse: true });
PersonSchema.index({ displayName: 1 });
PersonSchema.index({ emails: 1 });
PersonSchema.index({ "handles.$**": 1 }, { name: "people_handles_identity_wildcard" });
PersonSchema.index({ lastInteractionAt: -1 });
PersonSchema.index({ displayName: "text", notes: "text", tags: "text" }, { name: "people_text" });
PersonSchema.index({ deletedAt: 1 }, { sparse: true });

export const Person = model("Person", PersonSchema);
export type PersonDoc = ReturnType<(typeof Person)["hydrate"]>;
