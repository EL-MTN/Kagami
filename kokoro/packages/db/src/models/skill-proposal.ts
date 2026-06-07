import mongoose, { Schema, type Document } from "mongoose";

/**
 * Durable memory for self-authored skill proposals. Skill suggestions are
 * conversational and approval-gated, so declines need to outlive the short chat
 * window just like routine proposals do.
 */

export type SkillProposalVerdict = "accepted" | "declined";

export interface ISkillProposalDecision extends Document {
  id: string;
  chatId: string;
  signature: string;
  verdict: SkillProposalVerdict;
  denyCount: number;
  lastDecidedAt: Date;
  quietUntil: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const skillProposalDecisionSchema = new Schema<ISkillProposalDecision>(
  {
    chatId: { type: String, required: true },
    signature: { type: String, required: true },
    verdict: { type: String, enum: ["accepted", "declined"], required: true },
    denyCount: { type: Number, default: 0 },
    lastDecidedAt: { type: Date, required: true },
    quietUntil: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

skillProposalDecisionSchema.index({ chatId: 1, signature: 1 }, { unique: true });
skillProposalDecisionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SkillProposalDecision =
  (mongoose.models.SkillProposalDecision as mongoose.Model<ISkillProposalDecision>) ??
  mongoose.model<ISkillProposalDecision>("SkillProposalDecision", skillProposalDecisionSchema);

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_COOLDOWN_DAYS = 14;
const MAX_COOLDOWN_DAYS = 365;
const RETENTION_BUFFER_DAYS = 90;

function cooldownDaysFor(denyCount: number, baseDays: number): number {
  return Math.min(baseDays * Math.max(denyCount, 1), MAX_COOLDOWN_DAYS);
}

export interface RecordSkillProposalDecisionOptions {
  cooldownDays?: number;
}

export async function recordSkillProposalDecision(
  chatId: string,
  signature: string,
  verdict: SkillProposalVerdict,
  options: RecordSkillProposalDecisionOptions = {},
): Promise<void> {
  const base = options.cooldownDays ?? DEFAULT_COOLDOWN_DAYS;
  const now = new Date();

  const existing = await SkillProposalDecision.findOne({ chatId, signature });
  const denyCount =
    verdict === "declined" ? (existing?.denyCount ?? 0) + 1 : (existing?.denyCount ?? 0);
  const cooldownDays = verdict === "declined" ? cooldownDaysFor(denyCount, base) : base;

  const quietUntil = new Date(now.getTime() + cooldownDays * DAY_MS);
  const expiresAt = new Date(quietUntil.getTime() + RETENTION_BUFFER_DAYS * DAY_MS);

  await SkillProposalDecision.updateOne(
    { chatId, signature },
    { verdict, denyCount, lastDecidedAt: now, quietUntil, expiresAt },
    { upsert: true },
  );
}

export async function isSkillRecentlyDeclined(chatId: string, signature: string): Promise<boolean> {
  const row = await SkillProposalDecision.findOne({ chatId, signature });
  if (!row) return false;
  if (row.verdict === "accepted") return true;
  return row.quietUntil.getTime() > Date.now();
}
