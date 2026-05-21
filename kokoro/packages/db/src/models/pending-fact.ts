import mongoose, { Schema, type Document } from "mongoose";

export interface IPendingFact extends Document {
  id: string;
  text: string;
  eventDate?: string;
  sourceSession: string;
  userId?: string;
  status: "pending" | "failed";
  attemptCount: number;
  nextAttemptAt: Date;
  lastAttemptAt?: Date;
  lastError?: string;
  failedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PendingFactInput {
  text: string;
  eventDate?: string;
  sourceSession: string;
  userId?: string;
}

const pendingFactSchema = new Schema<IPendingFact>(
  {
    text: { type: String, required: true },
    eventDate: { type: String },
    sourceSession: { type: String, required: true },
    userId: { type: String },
    status: { type: String, enum: ["pending", "failed"], default: "pending", index: true },
    attemptCount: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    lastAttemptAt: { type: Date },
    lastError: { type: String },
    failedAt: { type: Date },
  },
  { timestamps: true },
);

pendingFactSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });

export const PendingFact =
  (mongoose.models.PendingFact as mongoose.Model<IPendingFact>) ??
  mongoose.model<IPendingFact>("PendingFact", pendingFactSchema);

export async function enqueuePendingFact(input: PendingFactInput): Promise<IPendingFact> {
  return PendingFact.create({
    text: input.text,
    eventDate: input.eventDate,
    sourceSession: input.sourceSession,
    userId: input.userId,
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: new Date(),
  });
}
