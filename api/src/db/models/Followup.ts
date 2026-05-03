import { Schema, model } from 'mongoose';
import { baseSchemaOptions, provenanceFields } from './base.js';

export const FOLLOWUP_DIRECTIONS = ['i_owe', 'they_owe'] as const;
export const FOLLOWUP_STATUSES = ['open', 'done', 'snoozed', 'dismissed'] as const;

const FollowupSchema = new Schema(
  {
    personId: { type: Schema.Types.ObjectId, ref: 'Person', required: true },
    direction: { type: String, required: true, enum: FOLLOWUP_DIRECTIONS },
    dueAt: { type: Date },
    status: {
      type: String,
      required: true,
      enum: FOLLOWUP_STATUSES,
      default: 'open',
    },
    reason: { type: String, required: true },
    sourceInteractionId: {
      type: Schema.Types.ObjectId,
      ref: 'Interaction',
      default: null,
    },
    ...provenanceFields,
  },
  baseSchemaOptions,
);

FollowupSchema.index({ status: 1, dueAt: 1 });
FollowupSchema.index({ personId: 1, direction: 1, status: 1 });
FollowupSchema.index({ deletedAt: 1 }, { sparse: true });

export const Followup = model('Followup', FollowupSchema);
export type FollowupDoc = ReturnType<(typeof Followup)['hydrate']>;
