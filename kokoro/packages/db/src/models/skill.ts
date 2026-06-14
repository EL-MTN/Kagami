import mongoose, { Schema, Types, type Document } from "mongoose";
import {
  snapshotSkillVersion,
  type SkillRevisionActor,
  type SkillRevisionReason,
} from "./skill-revision";

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
  opts: { expectedVersion?: number } = {},
): Promise<ISkill | null> {
  const filter: Record<string, unknown> = { _id: skillId };
  if (chatId) filter.chatId = chatId;
  // Optimistic-concurrency guard for the dashboard PATCH: when the caller passes
  // the version it edited, the write lands only if the skill is still at that
  // version, so two racing saves (or a save from a stale editor) get a null
  // instead of silently clobbering each other and dropping a history snapshot.
  if (opts.expectedVersion !== undefined) filter.version = opts.expectedVersion;
  const update: Record<string, unknown> = { ...patch };
  if (patch.linkedRoutineIds) {
    update.linkedRoutineIds = patch.linkedRoutineIds.map((id) => new Types.ObjectId(id));
  }
  // A version bump means the stored content changed, so any prior curation
  // verdict no longer describes what's stored — invalidate the review stamp
  // here at the model (callers that bump version: dashboard content edits)
  // rather than trusting every caller to remember. Enabled-only toggles don't
  // bump version and keep the stamp.
  if (patch.version !== undefined) {
    update.lastReviewedAt = null;
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
 * caller distinguishes the three via an existence check. Always clears
 * `lastReviewedAt`: the write produces a new version the curator has never
 * seen, so the previous verdict's cooldown must not shield it from the next
 * cycle.
 *
 * `requireEnabled` (default true) gates that `enabled: true` clause. The
 * dashboard rollback passes `false`: restoring an archived skill's content is a
 * legitimate direct operator action (no stale-bubble concern), and the restore
 * leaves `enabled` untouched, so the skill stays archived.
 */
export async function updateSkillIfVersion(
  skillId: string,
  chatId: string,
  expectedVersion: number,
  patch: Partial<Pick<ISkill, "description" | "body" | "triggers" | "tags" | "enabled">>,
  opts: { requireEnabled?: boolean } = {},
): Promise<ISkill | null> {
  const filter: Record<string, unknown> = { _id: skillId, chatId, version: expectedVersion };
  if (opts.requireEnabled ?? true) filter.enabled = true;
  return Skill.findOneAndUpdate(
    filter,
    { ...patch, version: expectedVersion + 1, lastReviewedAt: null },
    { returnDocument: "after" },
  );
}

/** Content fields whose change makes an edit worth preserving in history.
 * `enabled`-only patches (archive / re-enable) change no content and are
 * already recoverable, so they are NOT snapshotted. */
const CONTENT_KEYS = ["description", "body", "triggers", "tags"] as const;

/**
 * `updateSkillIfVersion` plus a history snapshot of the version it overwrites,
 * so a bad approved curation edit (or a regrettable merge) stays recoverable.
 * When the patch changes content, the pre-edit version is read first (only to
 * supply the snapshot content) and recorded to `SkillRevision` ONLY AFTER the
 * compare-and-set SUCCEEDS — a rejected edit (raced, archived, or gone) writes
 * no revision, so it can neither pollute that version's provenance nor evict a
 * real rollback point at the retention cap. The snapshot is best-effort and
 * idempotent, so it never blocks or fails the edit; the only exposure is the
 * narrow window between the atomic CAS write and the snapshot, where a hard
 * crash drops one version's history (the chain self-heals on the next edit).
 * The CAS itself is unchanged, so a concurrent edit is still rejected, not
 * clobbered. `requireEnabled` is forwarded to the CAS and the pre-edit read
 * (default true; the dashboard rollback passes false to restore an archived
 * skill's content while leaving it disabled). Returns exactly what
 * `updateSkillIfVersion` returns.
 */
export async function updateSkillIfVersionWithHistory(
  skillId: string,
  chatId: string,
  expectedVersion: number,
  patch: Partial<Pick<ISkill, "description" | "body" | "triggers" | "tags" | "enabled">>,
  supersededBy: { reason: SkillRevisionReason; actor: SkillRevisionActor; note?: string | null },
  opts: { requireEnabled?: boolean } = {},
): Promise<ISkill | null> {
  const requireEnabled = opts.requireEnabled ?? true;
  const isContentEdit = CONTENT_KEYS.some((key) => patch[key] !== undefined);
  // Read the pre-edit version up front (same filter as the CAS) purely to
  // supply the snapshot content. If the CAS then succeeds, the version was
  // still `expectedVersion` at write time, so nothing edited it in between and
  // this read is accurate.
  const beforeFilter: Record<string, unknown> = { _id: skillId, chatId, version: expectedVersion };
  if (requireEnabled) beforeFilter.enabled = true;
  const before = isContentEdit ? await Skill.findOne(beforeFilter) : null;

  const updated = await updateSkillIfVersion(skillId, chatId, expectedVersion, patch, {
    requireEnabled,
  });

  if (updated && before) {
    await snapshotSkillVersion(
      {
        skillId: before.id,
        chatId: before.chatId,
        version: before.version,
        name: before.name,
        description: before.description,
        body: before.body,
        triggers: before.triggers,
        tags: before.tags,
      },
      supersededBy,
    );
  }
  return updated;
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
 * Each stamp is conditional on the version the pass actually reviewed: a skill
 * edited mid-pass (version bumped, stamp cleared) is skipped rather than
 * re-stamped, so the unreviewed edit isn't hidden behind the cooldown by a
 * stamp describing the old content. `timestamps: false` so `updatedAt` is
 * untouched — a review is metadata about a skill, not an edit to it (the same
 * reasoning as `recordRoutineGrade` not bumping `version`). Best-effort;
 * callers treat a write failure as non-fatal.
 */
export async function markSkillsReviewed(
  chatId: string,
  skills: { id: string; version: number }[],
  at: Date = new Date(),
): Promise<void> {
  if (skills.length === 0) return;
  await Skill.bulkWrite(
    skills.map(({ id, version }) => ({
      updateOne: {
        filter: { _id: new Types.ObjectId(id), chatId, version },
        update: { $set: { lastReviewedAt: at } },
        timestamps: false,
      },
    })),
    { ordered: false },
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
