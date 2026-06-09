import mongoose, { Schema, Types, type Document } from "mongoose";

export type SkillSource = "manual" | "distilled" | "imported";
export type SkillSourceRefKind = "routine" | "conversation";

export interface ISkillSourceRef {
  kind: SkillSourceRefKind;
  id: string;
}

export interface ISkill extends Document {
  id: string;
  chatId: string;
  name: string;
  description: string;
  body: string;
  triggers: string[];
  tags: string[];
  enabled: boolean;
  source: SkillSource;
  sourceRef: ISkillSourceRef | null;
  linkedRoutineIds: Types.ObjectId[];
  version: number;
  lastUsedAt: Date | null;
  usageCount: number;
  lastReviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const skillSourceRefSchema = new Schema<ISkillSourceRef>(
  {
    kind: { type: String, enum: ["routine", "conversation"], required: true },
    id: { type: String, required: true },
  },
  { _id: false },
);

const skillSchema = new Schema<ISkill>(
  {
    chatId: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, required: true },
    body: { type: String, required: true },
    triggers: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    enabled: { type: Boolean, default: true },
    source: { type: String, enum: ["manual", "distilled", "imported"], default: "manual" },
    sourceRef: { type: skillSourceRefSchema, default: null },
    linkedRoutineIds: { type: [Schema.Types.ObjectId], ref: "Routine", default: [] },
    version: { type: Number, default: 1 },
    lastUsedAt: { type: Date, default: null },
    usageCount: { type: Number, default: 0 },
    lastReviewedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

skillSchema.index({ chatId: 1, name: 1 }, { unique: true });
skillSchema.index({ chatId: 1, enabled: 1 });
skillSchema.index({ chatId: 1, tags: 1 });
skillSchema.index({
  name: "text",
  description: "text",
  body: "text",
  triggers: "text",
  tags: "text",
});

export const Skill =
  (mongoose.models.Skill as mongoose.Model<ISkill>) ?? mongoose.model<ISkill>("Skill", skillSchema);

export interface SkillInput {
  name: string;
  description: string;
  body: string;
  triggers?: string[];
  tags?: string[];
  enabled?: boolean;
  source?: SkillSource;
  sourceRef?: ISkillSourceRef | null;
  linkedRoutineIds?: string[];
}

export async function createSkill(chatId: string, input: SkillInput): Promise<ISkill> {
  return Skill.create({
    chatId,
    ...input,
    linkedRoutineIds: (input.linkedRoutineIds ?? []).map((id) => new Types.ObjectId(id)),
  });
}

export async function listSkillsForChat(chatId: string): Promise<ISkill[]> {
  return Skill.find({ chatId }).sort({ createdAt: -1 });
}

export async function listEnabledSkillsForChat(chatId: string): Promise<ISkill[]> {
  return Skill.find({ chatId, enabled: true }).sort({ createdAt: -1 });
}

export async function getSkillById(skillId: string, chatId?: string): Promise<ISkill | null> {
  const filter: Record<string, unknown> = { _id: skillId };
  if (chatId) filter.chatId = chatId;
  return Skill.findOne(filter);
}

export async function getSkillByName(chatId: string, name: string): Promise<ISkill | null> {
  return Skill.findOne({ chatId, name });
}

export async function resolveSkillRef(chatId: string, identifier: string): Promise<ISkill | null> {
  if (Types.ObjectId.isValid(identifier)) {
    const byId = await getSkillById(identifier, chatId);
    if (byId) return byId;
  }
  return getSkillByName(chatId, identifier);
}

export async function updateSkill(
  skillId: string,
  patch: Partial<
    Pick<
      ISkill,
      | "name"
      | "description"
      | "body"
      | "triggers"
      | "tags"
      | "enabled"
      | "source"
      | "sourceRef"
      | "version"
    >
  > & { linkedRoutineIds?: string[] },
  chatId?: string,
): Promise<ISkill | null> {
  const filter: Record<string, unknown> = { _id: skillId };
  if (chatId) filter.chatId = chatId;
  const update: Record<string, unknown> = { ...patch };
  if (patch.linkedRoutineIds) {
    update.linkedRoutineIds = patch.linkedRoutineIds.map((id) => new Types.ObjectId(id));
  }
  return Skill.findOneAndUpdate(filter, update, { returnDocument: "after" });
}

export async function deleteSkill(skillId: string, chatId?: string): Promise<boolean> {
  const filter: Record<string, unknown> = { _id: skillId };
  if (chatId) filter.chatId = chatId;
  const result = await Skill.findOneAndDelete(filter);
  return result !== null;
}

export async function recordSkillUsed(skillId: string, chatId?: string): Promise<void> {
  const filter: Record<string, unknown> = { _id: skillId };
  if (chatId) filter.chatId = chatId;
  await Skill.updateOne(filter, {
    $inc: { usageCount: 1 },
    $set: { lastUsedAt: new Date() },
  });
}

/**
 * Atomically apply a skill edit only if its version still equals
 * `expectedVersion` AND it is still enabled, bumping the version on success.
 * The skill counterpart of `updateRoutineIfVersion`: closes the
 * read-then-write race in the gated dispatcher, so a concurrent edit
 * (dashboard / another bubble) landing while a curation proposal sat
 * unapproved is rejected (returns null), not clobbered. The `enabled: true`
 * clause exists because a dashboard enable-toggle does NOT bump `version`
 * (unlike routines, whose dashboard PATCH always bumps) — without it a stale
 * approval would land on a skill the user archived after the bubble was
 * raised. Every curation proposal originates on an enabled skill, so requiring
 * enabled here is never a false rejection. Returns the updated doc, or null if
 * the skill is gone, its version moved on, OR it has been disabled — the
 * caller distinguishes the three via an existence check.
 */
export async function updateSkillIfVersion(
  skillId: string,
  chatId: string,
  expectedVersion: number,
  patch: Partial<Pick<ISkill, "description" | "body" | "triggers" | "tags" | "enabled">>,
): Promise<ISkill | null> {
  return Skill.findOneAndUpdate(
    { _id: skillId, chatId, version: expectedVersion, enabled: true },
    { ...patch, version: expectedVersion + 1 },
    { returnDocument: "after" },
  );
}

// --- Skill-review (curation) pre-filter tuning. Facts only — the predicate
// selects which skills are WORTH a paid LLM look; the LLM still decides what
// (if anything) to do. ---
// A skill is stale once it has gone this long without being read (or, if never
// read, since creation).
const STALE_AFTER_DAYS = 30;
// A stale skill the curator already looked at (and kept) isn't re-reviewed
// until this much time has passed — staleness alone shouldn't burn an LLM call
// every weekly cycle.
const REVIEW_COOLDOWN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a skill deserves a curation look: it has never been reviewed (new
 * skills get an overlap/quality check on the next cycle), or it has gone stale
 * since the last review. The skill counterpart of `routineNeedsAttention` —
 * skills have no run log, so recency-of-use is the only mechanical signal.
 */
export function skillNeedsReview(
  skill: Pick<ISkill, "enabled" | "createdAt" | "lastUsedAt" | "lastReviewedAt">,
  now: Date = new Date(),
): boolean {
  if (!skill.enabled) return false;
  if (!skill.lastReviewedAt) return true;
  const lastActivity = skill.lastUsedAt ?? skill.createdAt;
  const stale = now.getTime() - lastActivity.getTime() >= STALE_AFTER_DAYS * DAY_MS;
  const cooledDown =
    now.getTime() - skill.lastReviewedAt.getTime() >= REVIEW_COOLDOWN_DAYS * DAY_MS;
  return stale && cooledDown;
}

/**
 * Stamp `lastReviewedAt` on the skills a curation pass actually examined.
 * `timestamps: false` so `updatedAt` is untouched — a review is metadata about
 * a skill, not an edit to it (the same reasoning as `recordRoutineGrade` not
 * bumping `version`). Best-effort; callers treat a write failure as non-fatal.
 */
export async function markSkillsReviewed(
  chatId: string,
  skillIds: string[],
  at: Date = new Date(),
): Promise<void> {
  if (skillIds.length === 0) return;
  await Skill.updateMany(
    { _id: { $in: skillIds.map((id) => new Types.ObjectId(id)) }, chatId },
    { $set: { lastReviewedAt: at } },
    { timestamps: false },
  );
}

/**
 * Distinct chatIds that currently own at least one enabled skill. The skill
 * curation scheduler uses this to enumerate which chats to audit, exactly as
 * `listChatIdsWithRoutines` does for the routine self-review.
 */
export async function listChatIdsWithSkills(): Promise<string[]> {
  return Skill.distinct("chatId", { enabled: true });
}
