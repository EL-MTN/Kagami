import mongoose, { Schema, Types, type Document } from "mongoose";

// --- Skill Parameter ---

export type SkillParameterType = "string" | "number" | "boolean" | "array" | "object";

export interface ISkillParameter {
  name: string;
  type: SkillParameterType;
  description: string;
  required: boolean;
  default?: unknown;
}

const skillParameterSchema = new Schema<ISkillParameter>(
  {
    name: { type: String, required: true },
    type: {
      type: String,
      enum: ["string", "number", "boolean", "array", "object"],
      required: true,
    },
    description: { type: String, required: true },
    required: { type: Boolean, required: true },
    default: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

// --- Skill ---

export type SkillPurity = "read" | "action";

export interface ISkill extends Document {
  chatId: string;
  name: string;
  description: string;
  prompt: string;
  parameters: ISkillParameter[];
  cronSchedule: string | null;
  reportMode: "always" | "alert";
  /**
   * "read" = skill only observes (search, summarize, query). Safe to call from
   * a watcher context.
   * "action" = skill mutates external state (sends, writes, modifies). Watchers
   * cannot invoke action skills.
   * Defaults to "action" so existing skills remain conservatively gated until
   * an author explicitly marks them safe.
   */
  purity: SkillPurity;
  nextRunAt: Date | null;
  manualRunRequestedAt: Date | null;
  enabled: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const skillSchema = new Schema<ISkill>(
  {
    chatId: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, required: true },
    prompt: { type: String, required: true },
    parameters: { type: [skillParameterSchema], default: [] },
    cronSchedule: { type: String, default: null },
    reportMode: { type: String, enum: ["always", "alert"], required: true },
    purity: { type: String, enum: ["read", "action"], required: true, default: "action" },
    nextRunAt: { type: Date, default: null },
    manualRunRequestedAt: { type: Date, default: null },
    enabled: { type: Boolean, default: true },
    version: { type: Number, default: 1 },
  },
  { timestamps: true },
);

skillSchema.index({ chatId: 1 });
skillSchema.index({ chatId: 1, name: 1 }, { unique: true });
skillSchema.index({ enabled: 1, nextRunAt: 1 });
skillSchema.index({ manualRunRequestedAt: 1 });

export const Skill =
  (mongoose.models.Skill as mongoose.Model<ISkill>) ?? mongoose.model<ISkill>("Skill", skillSchema);

// --- Skill Log ---

export interface ISkillLog extends Document {
  skillId: Types.ObjectId;
  trigger: "cron" | "manual" | "skill";
  parentLogId?: Types.ObjectId;
  parameters?: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  summary?: string;
  startedAt: Date;
  completedAt?: Date;
}

const skillLogSchema = new Schema<ISkillLog>({
  skillId: { type: Schema.Types.ObjectId, ref: "Skill", required: true },
  trigger: { type: String, enum: ["cron", "manual", "skill"], required: true },
  parentLogId: { type: Schema.Types.ObjectId, ref: "SkillLog" },
  parameters: { type: Schema.Types.Mixed },
  status: { type: String, enum: ["running", "completed", "failed"], required: true },
  summary: { type: String },
  startedAt: { type: Date, required: true },
  completedAt: { type: Date },
});

skillLogSchema.index({ skillId: 1, startedAt: -1 });

export const SkillLog =
  (mongoose.models.SkillLog as mongoose.Model<ISkillLog>) ??
  mongoose.model<ISkillLog>("SkillLog", skillLogSchema);

// --- Skill Helpers ---

export interface SkillInput {
  name: string;
  description: string;
  prompt: string;
  parameters?: ISkillParameter[];
  cronSchedule?: string | null;
  reportMode: "always" | "alert";
  purity?: SkillPurity;
  nextRunAt?: Date | null;
  /** Defaults to true via schema. Pass false to import a disabled skill. */
  enabled?: boolean;
}

export async function createSkill(chatId: string, input: SkillInput): Promise<ISkill> {
  return Skill.create({ chatId, ...input });
}

export async function listSkillsForChat(chatId: string): Promise<ISkill[]> {
  return Skill.find({ chatId }).sort({ createdAt: -1 });
}

export async function getSkillById(skillId: string, chatId?: string): Promise<ISkill | null> {
  const filter: Record<string, unknown> = { _id: skillId };
  if (chatId) filter.chatId = chatId;
  return Skill.findOne(filter);
}

export async function getSkillByName(chatId: string, name: string): Promise<ISkill | null> {
  return Skill.findOne({ chatId, name });
}

export async function updateSkill(
  skillId: string,
  patch: Partial<
    Pick<
      ISkill,
      | "name"
      | "description"
      | "prompt"
      | "parameters"
      | "cronSchedule"
      | "reportMode"
      | "purity"
      | "enabled"
      | "nextRunAt"
      | "version"
    >
  >,
  chatId?: string,
): Promise<ISkill | null> {
  const filter: Record<string, unknown> = { _id: skillId };
  if (chatId) filter.chatId = chatId;
  return Skill.findOneAndUpdate(filter, patch, { new: true });
}

export async function deleteSkill(skillId: string, chatId?: string): Promise<boolean> {
  const filter: Record<string, unknown> = { _id: skillId };
  if (chatId) filter.chatId = chatId;
  const result = await Skill.findOneAndDelete(filter);
  if (result) {
    await SkillLog.deleteMany({ skillId: new Types.ObjectId(skillId) });
  }
  return result !== null;
}

export async function getDueSkills(): Promise<ISkill[]> {
  return Skill.find({
    enabled: true,
    cronSchedule: { $ne: null },
    nextRunAt: { $lte: new Date() },
  }).sort({ nextRunAt: 1 });
}

export async function advanceSkillNextRunAt(skillId: string, nextRunAt: Date): Promise<void> {
  await Skill.findByIdAndUpdate(skillId, { nextRunAt });
}

export async function requestManualRun(skillId: string): Promise<ISkill | null> {
  return Skill.findByIdAndUpdate(skillId, { manualRunRequestedAt: new Date() }, { new: true });
}

/**
 * Atomically claim the next pending manual-run request. Sets
 * `manualRunRequestedAt` back to null so this won't be picked up twice.
 */
export async function claimPendingManualRun(): Promise<ISkill | null> {
  return Skill.findOneAndUpdate(
    { manualRunRequestedAt: { $ne: null }, enabled: true },
    { manualRunRequestedAt: null },
    { sort: { manualRunRequestedAt: 1 }, new: false },
  );
}

// --- Skill Log Helpers ---

const STALE_RUNNING_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

export async function isSkillRunning(skillId: string): Promise<boolean> {
  const exists = await SkillLog.exists({
    skillId: new Types.ObjectId(skillId),
    status: "running",
    startedAt: { $gte: new Date(Date.now() - STALE_RUNNING_THRESHOLD_MS) },
  });
  return exists !== null;
}

export async function createSkillLog(
  skillId: string,
  trigger: "cron" | "manual" | "skill",
  options?: { parentLogId?: string; parameters?: Record<string, unknown> },
): Promise<ISkillLog> {
  return SkillLog.create({
    skillId: new Types.ObjectId(skillId),
    trigger,
    parentLogId: options?.parentLogId ? new Types.ObjectId(options.parentLogId) : undefined,
    parameters: options?.parameters,
    status: "running",
    startedAt: new Date(),
  });
}

export async function completeSkillLog(logId: string, summary: string): Promise<void> {
  await SkillLog.findByIdAndUpdate(logId, {
    status: "completed",
    summary,
    completedAt: new Date(),
  });
}

export async function failSkillLog(logId: string, reason: string): Promise<void> {
  await SkillLog.findByIdAndUpdate(logId, {
    status: "failed",
    summary: reason,
    completedAt: new Date(),
  });
}

export async function getSkillLogs(skillId: string, limit = 50): Promise<ISkillLog[]> {
  return SkillLog.find({ skillId: new Types.ObjectId(skillId) })
    .sort({ startedAt: -1 })
    .limit(limit);
}

export async function cleanupOldSkillLogs(olderThanDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await SkillLog.deleteMany({
    status: { $ne: "running" },
    startedAt: { $lt: cutoff },
  });
  return result.deletedCount;
}

export async function resetStaleRunningSkillLogs(): Promise<number> {
  const result = await SkillLog.updateMany(
    {
      status: "running",
      startedAt: { $lt: new Date(Date.now() - STALE_RUNNING_THRESHOLD_MS) },
    },
    { status: "failed", summary: "Process crashed during execution", completedAt: new Date() },
  );
  return result.modifiedCount;
}
