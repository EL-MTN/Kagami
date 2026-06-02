import mongoose, { Schema, type Document } from "mongoose";

/**
 * Durable memory of how Goshujin-sama responded to a self-authored routine
 * proposal (see apps/bot/src/ai/tools/routine-proposals.ts). The conversational
 * model offers to save a just-completed task as a routine; if he declines, we
 * must remember that decline so the model doesn't nag again — the 40-message
 * context window + 1h session reset mean the LLM cannot reliably see a prior
 * "no" on its own.
 *
 * Keyed by (chatId, signature) where signature = normalized name + short prompt
 * hash, so a re-offer of the *same* proposal is suppressed while a genuinely
 * different task can still be proposed.
 */

export type ProposalVerdict = "accepted" | "declined";

export interface IRoutineProposalDecision extends Document {
  id: string;
  chatId: string;
  signature: string;
  verdict: ProposalVerdict;
  /** Number of times this signature has been declined. Drives the escalating cooldown. */
  denyCount: number;
  lastDecidedAt: Date;
  /**
   * Until when we stay quiet about this signature. For a decline this grows with
   * `denyCount`; the proposeRoutine guard treats a row whose `quietUntil` is in
   * the future as "recently declined".
   */
  quietUntil: Date;
  /** TTL — Mongo auto-removes the record after this. Set well past `quietUntil`
   * so the `denyCount` escalation history survives the quiet window. */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const routineProposalDecisionSchema = new Schema<IRoutineProposalDecision>(
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

routineProposalDecisionSchema.index({ chatId: 1, signature: 1 }, { unique: true });
// TTL index: MongoDB auto-removes documents after expiresAt is reached.
routineProposalDecisionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RoutineProposalDecision =
  (mongoose.models.RoutineProposalDecision as mongoose.Model<IRoutineProposalDecision>) ??
  mongoose.model<IRoutineProposalDecision>(
    "RoutineProposalDecision",
    routineProposalDecisionSchema,
  );

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_COOLDOWN_DAYS = 14;
/** Hard ceiling on the escalating cooldown so a much-declined proposal still
 * eventually clears rather than being silenced forever. */
const MAX_COOLDOWN_DAYS = 365;
/** Retention buffer past `quietUntil` so escalation history outlives the quiet
 * window — a re-offer right after the window expires still counts as repeat. */
const RETENTION_BUFFER_DAYS = 90;

/**
 * Cooldown for the Nth decline: linear in `denyCount`, capped. First decline →
 * base; second → 2× base; etc. Repeat declines stay quiet progressively longer.
 */
function cooldownDaysFor(denyCount: number, baseDays: number): number {
  return Math.min(baseDays * Math.max(denyCount, 1), MAX_COOLDOWN_DAYS);
}

export interface RecordProposalDecisionOptions {
  /** Base cooldown for a first decline (and the accepted quiet window). Default 14. */
  cooldownDays?: number;
}

/**
 * Record an accept/decline for a proposal signature. Declines increment
 * `denyCount` and lengthen the quiet window; an accept resets the quiet window
 * to the base (the routine now exists, so it won't be re-proposed anyway).
 * Upserts on (chatId, signature). Best-effort — callers treat failures as
 * non-fatal so a write blip never wedges the deny/approve path.
 */
export async function recordProposalDecision(
  chatId: string,
  signature: string,
  verdict: ProposalVerdict,
  options: RecordProposalDecisionOptions = {},
): Promise<void> {
  const base = options.cooldownDays ?? DEFAULT_COOLDOWN_DAYS;
  const now = new Date();

  const existing = await RoutineProposalDecision.findOne({ chatId, signature });
  const denyCount =
    verdict === "declined" ? (existing?.denyCount ?? 0) + 1 : (existing?.denyCount ?? 0);
  const cooldownDays = verdict === "declined" ? cooldownDaysFor(denyCount, base) : base;

  const quietUntil = new Date(now.getTime() + cooldownDays * DAY_MS);
  const expiresAt = new Date(quietUntil.getTime() + RETENTION_BUFFER_DAYS * DAY_MS);

  await RoutineProposalDecision.updateOne(
    { chatId, signature },
    { verdict, denyCount, lastDecidedAt: now, quietUntil, expiresAt },
    { upsert: true },
  );
}

/**
 * True if this signature was declined recently enough that we should NOT
 * re-propose it. An accepted record also suppresses re-proposal while it lives
 * (the routine already exists). Runs code-side before any bubble is raised, so
 * even an over-eager model is throttled.
 */
export async function isRecentlyDeclined(chatId: string, signature: string): Promise<boolean> {
  const row = await RoutineProposalDecision.findOne({ chatId, signature });
  if (!row) return false;
  if (row.verdict === "accepted") return true;
  return row.quietUntil.getTime() > Date.now();
}
