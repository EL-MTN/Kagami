import { Schema, model } from "mongoose";
import { baseSchemaOptions, provenanceFields } from "./base.js";

export const FOLLOWUP_DIRECTIONS = ["i_owe", "they_owe"] as const;
export const FOLLOWUP_STATUSES = ["open", "done", "snoozed", "dismissed"] as const;

const FollowupSchema = new Schema(
  {
    personId: { type: Schema.Types.ObjectId, ref: "Person", required: true },
    direction: { type: String, required: true, enum: FOLLOWUP_DIRECTIONS },
    dueAt: { type: Date },
    duePriorityBucket: { type: Number, required: true, enum: [0, 1], default: 1 },
    status: {
      type: String,
      required: true,
      enum: FOLLOWUP_STATUSES,
      default: "open",
    },
    reason: { type: String, required: true },
    sourceInteractionId: {
      type: Schema.Types.ObjectId,
      ref: "Interaction",
      default: null,
    },
    ...provenanceFields,
  },
  baseSchemaOptions,
);

FollowupSchema.pre("validate", function setDuePriorityBucket(next) {
  this.set("duePriorityBucket", this.get("dueAt") ? 0 : 1);
  next();
});

FollowupSchema.index({ status: 1, dueAt: 1 });
FollowupSchema.index({ personId: 1, direction: 1, status: 1 });
FollowupSchema.index(
  { status: 1, duePriorityBucket: 1, dueAt: 1, _id: -1 },
  { name: "followups_due_priority_page" },
);
FollowupSchema.index(
  { status: 1, personId: 1, direction: 1, duePriorityBucket: 1, dueAt: 1, _id: -1 },
  { name: "followups_due_priority_scoped_page" },
);
FollowupSchema.index({ deletedAt: 1 }, { sparse: true });

export const Followup = model("Followup", FollowupSchema);
