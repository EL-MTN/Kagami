import { Schema, model } from "mongoose";
import { baseSchemaOptions, provenanceFields } from "./base.js";

const OrganizationSchema = new Schema(
  {
    name: { type: String, required: true },
    domain: { type: String, lowercase: true, trim: true },
    website: { type: String },
    industry: { type: String },
    notes: { type: String },
    ...provenanceFields,
  },
  baseSchemaOptions,
);

OrganizationSchema.index({ domain: 1 }, { unique: true, sparse: true });
OrganizationSchema.index({ deletedAt: 1 }, { sparse: true });

export const Organization = model("Organization", OrganizationSchema);
export type OrganizationDoc = ReturnType<(typeof Organization)["hydrate"]>;
