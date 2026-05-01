import mongoose, { Schema, Types, type Document } from "mongoose";

// --- Routine Parameter ---

export type RoutineParameterType = "string" | "number" | "boolean" | "array" | "object";

export interface IRoutineParameter {
  name: string;
  type: RoutineParameterType;
  description: string;
  required: boolean;
  default?: unknown;
}

const routineParameterSchema = new Schema<IRoutineParameter>(
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

// --- Routine ---

export type RoutinePurity = "read" | "action";

export interface IRoutine extends Document {
  chatId: string;
  name: string;
  description: string;
  prompt: string;
  parameters: IRoutineParameter[];
  cronSchedule: string | null;
  reportMode: "always" | "alert";
  /**
   * "read" = routine only observes (search, summarize, query). Safe to call from
   * a watcher context.
   * "action" = routine mutates external state (sends, writes, modifies). Watchers
   * cannot invoke action routines.
   * Defaults to "action" so existing routines remain conservatively gated until
   * an author explicitly marks them safe.
   */
  purity: RoutinePurity;
  nextRunAt: Date | null;
  manualRunRequestedAt: Date | null;
  enabled: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const routineSchema = new Schema<IRoutine>(
  {
    chatId: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, required: true },
    prompt: { type: String, required: true },
    parameters: { type: [routineParameterSchema], default: [] },
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

routineSchema.index({ chatId: 1 });
routineSchema.index({ chatId: 1, name: 1 }, { unique: true });
routineSchema.index({ enabled: 1, nextRunAt: 1 });
routineSchema.index({ manualRunRequestedAt: 1 });

export const Routine =
  (mongoose.models.Routine as mongoose.Model<IRoutine>) ??
  mongoose.model<IRoutine>("Routine", routineSchema);

// --- Routine Log ---

export interface IRoutineLog extends Document {
  routineId: Types.ObjectId;
  trigger: "cron" | "manual" | "routine";
  parentLogId?: Types.ObjectId;
  parameters?: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  summary?: string;
  startedAt: Date;
  completedAt?: Date;
}

const routineLogSchema = new Schema<IRoutineLog>({
  routineId: { type: Schema.Types.ObjectId, ref: "Routine", required: true },
  trigger: { type: String, enum: ["cron", "manual", "routine"], required: true },
  parentLogId: { type: Schema.Types.ObjectId, ref: "RoutineLog" },
  parameters: { type: Schema.Types.Mixed },
  status: { type: String, enum: ["running", "completed", "failed"], required: true },
  summary: { type: String },
  startedAt: { type: Date, required: true },
  completedAt: { type: Date },
});

routineLogSchema.index({ routineId: 1, startedAt: -1 });

export const RoutineLog =
  (mongoose.models.RoutineLog as mongoose.Model<IRoutineLog>) ??
  mongoose.model<IRoutineLog>("RoutineLog", routineLogSchema);

// --- Routine Helpers ---

export interface RoutineInput {
  name: string;
  description: string;
  prompt: string;
  parameters?: IRoutineParameter[];
  cronSchedule?: string | null;
  reportMode: "always" | "alert";
  purity?: RoutinePurity;
  nextRunAt?: Date | null;
  /** Defaults to true via schema. Pass false to import a disabled routine. */
  enabled?: boolean;
}

export async function createRoutine(chatId: string, input: RoutineInput): Promise<IRoutine> {
  return Routine.create({ chatId, ...input });
}

export async function listRoutinesForChat(chatId: string): Promise<IRoutine[]> {
  return Routine.find({ chatId }).sort({ createdAt: -1 });
}

export async function getRoutineById(routineId: string, chatId?: string): Promise<IRoutine | null> {
  const filter: Record<string, unknown> = { _id: routineId };
  if (chatId) filter.chatId = chatId;
  return Routine.findOne(filter);
}

export async function getRoutineByName(chatId: string, name: string): Promise<IRoutine | null> {
  return Routine.findOne({ chatId, name });
}

export async function updateRoutine(
  routineId: string,
  patch: Partial<
    Pick<
      IRoutine,
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
): Promise<IRoutine | null> {
  const filter: Record<string, unknown> = { _id: routineId };
  if (chatId) filter.chatId = chatId;
  return Routine.findOneAndUpdate(filter, patch, { new: true });
}

export async function deleteRoutine(routineId: string, chatId?: string): Promise<boolean> {
  const filter: Record<string, unknown> = { _id: routineId };
  if (chatId) filter.chatId = chatId;
  const result = await Routine.findOneAndDelete(filter);
  if (result) {
    await RoutineLog.deleteMany({ routineId: new Types.ObjectId(routineId) });
  }
  return result !== null;
}

export async function getDueRoutines(): Promise<IRoutine[]> {
  return Routine.find({
    enabled: true,
    cronSchedule: { $ne: null },
    nextRunAt: { $lte: new Date() },
  }).sort({ nextRunAt: 1 });
}

export async function advanceRoutineNextRunAt(routineId: string, nextRunAt: Date): Promise<void> {
  await Routine.findByIdAndUpdate(routineId, { nextRunAt });
}

export async function requestManualRun(routineId: string): Promise<IRoutine | null> {
  return Routine.findByIdAndUpdate(routineId, { manualRunRequestedAt: new Date() }, { new: true });
}

/**
 * Atomically claim the next pending manual-run request. Sets
 * `manualRunRequestedAt` back to null so this won't be picked up twice.
 */
export async function claimPendingManualRun(): Promise<IRoutine | null> {
  return Routine.findOneAndUpdate(
    { manualRunRequestedAt: { $ne: null }, enabled: true },
    { manualRunRequestedAt: null },
    { sort: { manualRunRequestedAt: 1 }, new: false },
  );
}

// --- Routine Log Helpers ---

const STALE_RUNNING_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

export async function isRoutineRunning(routineId: string): Promise<boolean> {
  const exists = await RoutineLog.exists({
    routineId: new Types.ObjectId(routineId),
    status: "running",
    startedAt: { $gte: new Date(Date.now() - STALE_RUNNING_THRESHOLD_MS) },
  });
  return exists !== null;
}

export async function createRoutineLog(
  routineId: string,
  trigger: "cron" | "manual" | "routine",
  options?: { parentLogId?: string; parameters?: Record<string, unknown> },
): Promise<IRoutineLog> {
  return RoutineLog.create({
    routineId: new Types.ObjectId(routineId),
    trigger,
    parentLogId: options?.parentLogId ? new Types.ObjectId(options.parentLogId) : undefined,
    parameters: options?.parameters,
    status: "running",
    startedAt: new Date(),
  });
}

export async function completeRoutineLog(logId: string, summary: string): Promise<void> {
  await RoutineLog.findByIdAndUpdate(logId, {
    status: "completed",
    summary,
    completedAt: new Date(),
  });
}

export async function failRoutineLog(logId: string, reason: string): Promise<void> {
  await RoutineLog.findByIdAndUpdate(logId, {
    status: "failed",
    summary: reason,
    completedAt: new Date(),
  });
}

export async function getRoutineLogs(routineId: string, limit = 50): Promise<IRoutineLog[]> {
  return RoutineLog.find({ routineId: new Types.ObjectId(routineId) })
    .sort({ startedAt: -1 })
    .limit(limit);
}

export async function cleanupOldRoutineLogs(olderThanDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await RoutineLog.deleteMany({
    status: { $ne: "running" },
    startedAt: { $lt: cutoff },
  });
  return result.deletedCount;
}

export async function resetStaleRunningRoutineLogs(): Promise<number> {
  const result = await RoutineLog.updateMany(
    {
      status: "running",
      startedAt: { $lt: new Date(Date.now() - STALE_RUNNING_THRESHOLD_MS) },
    },
    { status: "failed", summary: "Process crashed during execution", completedAt: new Date() },
  );
  return result.modifiedCount;
}
