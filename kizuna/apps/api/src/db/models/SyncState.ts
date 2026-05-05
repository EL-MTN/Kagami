import { Schema, model } from "mongoose";
import { baseSchemaOptions, provenanceFields } from "./base.js";

const SyncStateSchema = new Schema(
  {
    provider: {
      type: String,
      required: true,
      enum: ["gmail", "gcal"],
      unique: true,
    },
    historyId: { type: String, default: null },
    syncToken: { type: String, default: null },
    lastRunAt: { type: Date, default: null },
    errorCount: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    pausedAt: { type: Date, default: null },
    ...provenanceFields,
  },
  baseSchemaOptions,
);

SyncStateSchema.index({ deletedAt: 1 }, { sparse: true });

export const SyncState = model("SyncState", SyncStateSchema);
export type SyncStateDoc = ReturnType<(typeof SyncState)["hydrate"]>;
