import type { SchemaOptions } from "mongoose";

export const SOURCE_VALUES = ["concierge", "gmail-sync", "gcal-sync", "manual", "import"] as const;

export type Source = (typeof SOURCE_VALUES)[number];

export const baseSchemaOptions: SchemaOptions = {
  timestamps: true,
  strict: "throw",
  versionKey: false,
};

export const provenanceFields = {
  source: {
    type: String,
    required: true,
    enum: SOURCE_VALUES,
  },
  sourceVersion: { type: String },
  deletedAt: { type: Date, default: null },
};
