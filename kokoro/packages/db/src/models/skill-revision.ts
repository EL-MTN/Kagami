import mongoose, { Schema, Types, type Document } from "mongoose";
import { logger } from "@kokoro/shared";

/**
 * Per-version content history for skills. A skill's curation actions (refine /
 * merge) and dashboard content edits OVERWRITE the live `Skill` doc in place,
 * so without this collection a bad approved edit is irrecoverable. Each row is
 * an immutable snapshot of one version's content, written right after that
 * version is superseded by a content edit — the current version always lives on
 * the `Skill` doc, so the full timeline is `revisions ∪ live`.
 *
 * This is the skill counterpart of the routine loop-closure snapshot
 * (`priorPrompt`/`priorParameters` on the routine doc), generalized from one
 * prior copy to N versions, and it doubles as the Hermes-style pre-edit
 * snapshot that backs a manual rollback. Archive/enable toggles are NOT
 * recorded — they change no content and are already recoverable by re-enabling
 * — so the history stays a pure content log.
 */

// The edit that supersedes a snapshotted version (advisory provenance shown in
// the dashboard timeline; the content fields are the load-bearing part).
export type SkillRevisionReason = "refine" | "merge" | "manual-edit" | "rollback" | "import";
export type SkillRevisionActor = "curator" | "dashboard" | "system";

export interface ISkillRevision extends Document {
  skillId: Types.ObjectId;
  chatId: string;
  /** The version whose content this row preserves. */
  version: number;
  // --- preserved content of that version ---
  name: string;
  description: string;
  body: string;
  triggers: string[];
  tags: string[];
  // --- context of the edit that replaced this version ---
  reason: SkillRevisionReason;
  actor: SkillRevisionActor;
  note: string | null;
  takenAt: Date;
}

const skillRevisionSchema = new Schema<ISkillRevision>(
  {
    skillId: { type: Schema.Types.ObjectId, ref: "Skill", required: true },
    chatId: { type: String, required: true },
    version: { type: Number, required: true },
    name: { type: String, required: true },
    description: { type: String, required: true },
    body: { type: String, required: true },
    triggers: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    reason: {
      type: String,
      enum: ["refine", "merge", "manual-edit", "rollback", "import"],
      required: true,
    },
    actor: { type: String, enum: ["curator", "dashboard", "system"], required: true },
    note: { type: String, default: null },
    takenAt: { type: Date, required: true },
  },
  { timestamps: false },
);

// One row per (skill, version): the content at a version is immutable, so a
// retried snapshot of the same version is an idempotent no-op (the upsert below
// relies on this). Also serves the newest-first history list via reverse scan.
skillRevisionSchema.index({ skillId: 1, version: 1 }, { unique: true });

export const SkillRevision =
  (mongoose.models.SkillRevision as mongoose.Model<ISkillRevision>) ??
  mongoose.model<ISkillRevision>("SkillRevision", skillRevisionSchema);

// Bounded history: skills are low-volume and edited rarely, so keeping the last
// N superseded versions is generous. A storage-retention cap, not a behavioral
// heuristic — promote to an env var only if it ever bites.
export const MAX_REVISIONS_PER_SKILL = 20;

export interface SkillVersionSnapshot {
  skillId: string;
  chatId: string;
  version: number;
  name: string;
  description: string;
  body: string;
  triggers: string[];
  tags: string[];
}

/**
 * Record a superseded skill version's content — called AFTER the superseding
 * edit has landed, so a rejected edit never leaves a stray revision. Idempotent
 * on `(skillId, version)` via `$setOnInsert` — the first writer wins and the
 * content of a version is never rewritten, so a retried dispatch can't corrupt
 * or duplicate a row. Best-effort: a snapshot failure is logged and swallowed
 * so it can never wedge the edit it follows. Prunes the oldest rows past
 * `MAX_REVISIONS_PER_SKILL` (also post-success, so a rejected edit can't evict
 * a real rollback point).
 */
export async function snapshotSkillVersion(
  snapshot: SkillVersionSnapshot,
  supersededBy: { reason: SkillRevisionReason; actor: SkillRevisionActor; note?: string | null },
  at: Date = new Date(),
): Promise<void> {
  const skillObjectId = new Types.ObjectId(snapshot.skillId);
  try {
    await SkillRevision.updateOne(
      { skillId: skillObjectId, version: snapshot.version },
      {
        $setOnInsert: {
          skillId: skillObjectId,
          chatId: snapshot.chatId,
          version: snapshot.version,
          name: snapshot.name,
          description: snapshot.description,
          body: snapshot.body,
          triggers: snapshot.triggers,
          tags: snapshot.tags,
          reason: supersededBy.reason,
          actor: supersededBy.actor,
          note: supersededBy.note ?? null,
          takenAt: at,
        },
      },
      { upsert: true },
    );
  } catch (error) {
    // A duplicate-key race (two writers, same version) is the idempotent path,
    // not a failure — the first writer's content stands. Any other error is
    // non-fatal to the edit, so log and move on.
    logger.warn(
      { error, skillId: snapshot.skillId, version: snapshot.version },
      "Failed to snapshot skill revision",
    );
    return;
  }
  await pruneSkillRevisions(snapshot.skillId, MAX_REVISIONS_PER_SKILL).catch((error) => {
    logger.warn({ error, skillId: snapshot.skillId }, "Failed to prune skill revisions");
  });
}

/** Drop the oldest revisions past the newest `keep` for one skill. */
export async function pruneSkillRevisions(skillId: string, keep: number): Promise<void> {
  const stale = await SkillRevision.find({ skillId: new Types.ObjectId(skillId) })
    .sort({ version: -1 })
    .skip(keep)
    .select({ _id: 1 })
    .lean();
  if (stale.length === 0) return;
  await SkillRevision.deleteMany({ _id: { $in: stale.map((r) => r._id) } });
}

/** A skill's superseded versions, newest first. The live (current) version is
 * NOT here — it is on the `Skill` doc; the dashboard composes the two. */
export async function listSkillRevisions(
  skillId: string,
  chatId: string,
  limit: number = MAX_REVISIONS_PER_SKILL,
): Promise<ISkillRevision[]> {
  return SkillRevision.find({ skillId: new Types.ObjectId(skillId), chatId })
    .sort({ version: -1 })
    .limit(limit);
}

/** One superseded version's snapshot — the source content for a rollback. */
export async function getSkillRevision(
  skillId: string,
  chatId: string,
  version: number,
): Promise<ISkillRevision | null> {
  return SkillRevision.findOne({ skillId: new Types.ObjectId(skillId), chatId, version });
}

/** Cascade-remove a skill's history when the skill is hard-deleted (archive,
 * the norm, leaves the doc and its history intact). */
export async function deleteSkillRevisions(skillId: string): Promise<void> {
  await SkillRevision.deleteMany({ skillId: new Types.ObjectId(skillId) });
}
