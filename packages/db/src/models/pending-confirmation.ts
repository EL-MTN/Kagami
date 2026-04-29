import mongoose, { Schema, type Document } from "mongoose";

export type PendingConfirmationStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";
export type PendingConfirmationOrigin = "conversation" | "skill" | "watcher";

export interface IPendingConfirmation extends Document {
  chatId: string;
  summary: string;
  action: {
    tool: string;
    args: Record<string, unknown>;
  };
  status: PendingConfirmationStatus;
  origin: PendingConfirmationOrigin;
  originRef?: string;
  promptMessageId?: string;
  resultText?: string;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt?: Date;
}

const pendingConfirmationSchema = new Schema<IPendingConfirmation>(
  {
    chatId: { type: String, required: true, index: true },
    summary: { type: String, required: true },
    action: {
      tool: { type: String, required: true },
      args: { type: Schema.Types.Mixed, required: true },
    },
    status: {
      type: String,
      enum: ["pending", "approved", "denied", "expired", "cancelled"],
      default: "pending",
      required: true,
    },
    origin: {
      type: String,
      enum: ["conversation", "skill", "watcher"],
      default: "conversation",
      required: true,
    },
    originRef: { type: String },
    promptMessageId: { type: String },
    resultText: { type: String },
    expiresAt: { type: Date, required: true },
    resolvedAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

pendingConfirmationSchema.index({ chatId: 1, status: 1, createdAt: -1 });
// TTL index: MongoDB auto-removes documents after expiresAt is reached.
pendingConfirmationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PendingConfirmation =
  (mongoose.models.PendingConfirmation as mongoose.Model<IPendingConfirmation>) ??
  mongoose.model<IPendingConfirmation>("PendingConfirmation", pendingConfirmationSchema);

export interface CreatePendingConfirmationInput {
  chatId: string;
  summary: string;
  action: { tool: string; args: Record<string, unknown> };
  origin?: PendingConfirmationOrigin;
  originRef?: string;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export async function createPendingConfirmation(
  input: CreatePendingConfirmationInput,
): Promise<IPendingConfirmation> {
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
  return PendingConfirmation.create({
    chatId: input.chatId,
    summary: input.summary,
    action: input.action,
    origin: input.origin ?? "conversation",
    originRef: input.originRef,
    expiresAt: new Date(Date.now() + ttl),
  });
}

export async function getPendingConfirmation(id: string): Promise<IPendingConfirmation | null> {
  return PendingConfirmation.findById(id);
}

export async function setPromptMessageId(id: string, messageId: string): Promise<void> {
  await PendingConfirmation.findByIdAndUpdate(id, { promptMessageId: messageId });
}

/**
 * Atomically transition a pending confirmation to a terminal state. Returns
 * the updated document only if the transition succeeded — i.e., the row was
 * still `pending` at the moment of the update. Lets the callback handler
 * reject double-clicks and races without extra coordination.
 *
 * The transition happens BEFORE the gated action is dispatched, so a second
 * click can't double-fire the underlying action. `resultText` is then
 * patched onto the row via `attachResultText` once dispatch settles.
 */
export async function resolvePendingConfirmation(
  id: string,
  verdict: "approved" | "denied" | "cancelled" | "expired",
  resultText?: string,
): Promise<IPendingConfirmation | null> {
  return PendingConfirmation.findOneAndUpdate(
    { _id: id, status: "pending" },
    {
      status: verdict,
      resolvedAt: new Date(),
      ...(resultText !== undefined ? { resultText } : {}),
    },
    { new: true },
  );
}

export async function attachResultText(id: string, resultText: string): Promise<void> {
  await PendingConfirmation.findByIdAndUpdate(id, { resultText });
}

/**
 * List pending (un-resolved, un-expired) confirmations for a chat. Used by
 * context assembly so the LLM is aware of approvals it's already requested.
 */
export async function listPendingConfirmations(chatId: string): Promise<IPendingConfirmation[]> {
  return PendingConfirmation.find({
    chatId,
    status: "pending",
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: 1 });
}
