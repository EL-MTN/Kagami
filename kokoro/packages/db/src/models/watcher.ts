import mongoose, { Schema, Types, type Document } from "mongoose";

// --- Watcher ---

export interface IWatcher extends Document {
  id: string;
  chatId: string;
  name: string;
  description: string;
  prompt: string;
  cronSchedule: string;
  reportMode: "alert";
  lastState: string | null;
  lastFiredAt: Date | null;
  fireCount: number;
  nextRunAt: Date | null;
  manualRunRequestedAt: Date | null;
  expiresAt: Date | null;
  enabled: boolean;
  archivedAt: Date | null;
  /** When true, archive the watcher after the first real fire. */
  oneShot: boolean;
  /** When set, archive after this many real fires. */
  maxFires: number | null;
  /** Minimum milliseconds between notifications. Triggers within the window are suppressed. */
  cooldownMs: number | null;
  /** Suppress notifications until this date. Detection still runs. */
  snoozedUntil: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const watcherSchema = new Schema<IWatcher>(
  {
    chatId: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, required: true },
    prompt: { type: String, required: true },
    cronSchedule: { type: String, required: true },
    reportMode: { type: String, enum: ["alert"], required: true, default: "alert" },
    lastState: { type: String, default: null },
    lastFiredAt: { type: Date, default: null },
    fireCount: { type: Number, default: 0 },
    nextRunAt: { type: Date, default: null },
    manualRunRequestedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    enabled: { type: Boolean, default: true },
    archivedAt: { type: Date, default: null },
    oneShot: { type: Boolean, default: false },
    maxFires: { type: Number, default: null },
    cooldownMs: { type: Number, default: null },
    snoozedUntil: { type: Date, default: null },
    version: { type: Number, default: 1 },
  },
  { timestamps: true },
);

watcherSchema.index({ chatId: 1 });
// Uniqueness scoped to non-archived rows so a name can be reused after archive.
watcherSchema.index(
  { chatId: 1, name: 1 },
  { unique: true, partialFilterExpression: { archivedAt: null } },
);
watcherSchema.index({ enabled: 1, archivedAt: 1, nextRunAt: 1 });
watcherSchema.index({ manualRunRequestedAt: 1 });

export const Watcher =
  (mongoose.models.Watcher as mongoose.Model<IWatcher>) ??
  mongoose.model<IWatcher>("Watcher", watcherSchema);

// --- Watcher Log ---

export interface IWatcherLog extends Document {
  id: string;
  watcherId: Types.ObjectId;
  trigger: "cron" | "manual";
  status: "running" | "completed" | "failed";
  triggered: boolean | null;
  /** Set when triggered=true was demoted to a non-fire by cooldown or snooze. */
  suppressed: boolean;
  summary: string | null;
  newState: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

const watcherLogSchema = new Schema<IWatcherLog>({
  watcherId: { type: Schema.Types.ObjectId, ref: "Watcher", required: true },
  trigger: { type: String, enum: ["cron", "manual"], required: true },
  status: { type: String, enum: ["running", "completed", "failed"], required: true },
  triggered: { type: Boolean, default: null },
  suppressed: { type: Boolean, default: false },
  summary: { type: String, default: null },
  newState: { type: String, default: null },
  startedAt: { type: Date, required: true },
  completedAt: { type: Date, default: null },
});

watcherLogSchema.index({ watcherId: 1, startedAt: -1 });

export const WatcherLog =
  (mongoose.models.WatcherLog as mongoose.Model<IWatcherLog>) ??
  mongoose.model<IWatcherLog>("WatcherLog", watcherLogSchema);

// --- Watcher Helpers ---

const STALE_RUNNING_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_EXPIRY_DAYS = 30;

export function defaultExpiresAt(from: Date = new Date()): Date {
  return new Date(from.getTime() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}

export interface WatcherInput {
  name: string;
  description: string;
  prompt: string;
  cronSchedule: string;
  expiresAt?: Date | null;
  nextRunAt?: Date | null;
  oneShot?: boolean;
  maxFires?: number | null;
  cooldownMs?: number | null;
  snoozedUntil?: Date | null;
  /** Defaults to true via schema. Pass false to import a disabled watcher. */
  enabled?: boolean;
}

export async function createWatcher(chatId: string, input: WatcherInput): Promise<IWatcher> {
  return Watcher.create({
    chatId,
    reportMode: "alert",
    ...input,
    expiresAt: input.expiresAt ?? defaultExpiresAt(),
  });
}

export async function listWatchersForChat(
  chatId: string,
  options?: { includeArchived?: boolean },
): Promise<IWatcher[]> {
  const filter: Record<string, unknown> = { chatId };
  if (!options?.includeArchived) filter.archivedAt = null;
  return Watcher.find(filter).sort({ createdAt: -1 });
}

export async function getWatcherById(watcherId: string, chatId?: string): Promise<IWatcher | null> {
  const filter: Record<string, unknown> = { _id: watcherId };
  if (chatId) filter.chatId = chatId;
  return Watcher.findOne(filter);
}

export async function getWatcherByName(chatId: string, name: string): Promise<IWatcher | null> {
  return Watcher.findOne({ chatId, name, archivedAt: null });
}

export async function updateWatcher(
  watcherId: string,
  patch: Partial<
    Pick<
      IWatcher,
      | "name"
      | "description"
      | "prompt"
      | "cronSchedule"
      | "enabled"
      | "expiresAt"
      | "nextRunAt"
      | "oneShot"
      | "maxFires"
      | "cooldownMs"
      | "snoozedUntil"
      | "version"
    >
  >,
  chatId?: string,
): Promise<IWatcher | null> {
  const filter: Record<string, unknown> = { _id: watcherId };
  if (chatId) filter.chatId = chatId;
  return Watcher.findOneAndUpdate(filter, patch, { returnDocument: "after" });
}

export async function deleteWatcher(watcherId: string, chatId?: string): Promise<boolean> {
  const filter: Record<string, unknown> = { _id: watcherId };
  if (chatId) filter.chatId = chatId;
  const result = await Watcher.findOneAndDelete(filter);
  if (result) {
    await WatcherLog.deleteMany({ watcherId: new Types.ObjectId(watcherId) });
  }
  return result !== null;
}

export async function archiveWatcher(watcherId: string): Promise<void> {
  await Watcher.updateOne({ _id: watcherId }, { archivedAt: new Date() });
}

export async function archiveExpiredWatchers(): Promise<number> {
  const now = new Date();
  const result = await Watcher.updateMany(
    {
      archivedAt: null,
      expiresAt: { $ne: null, $lte: now },
    },
    { archivedAt: now },
  );
  return result.modifiedCount;
}

export async function getDueWatchers(): Promise<IWatcher[]> {
  const now = new Date();
  return Watcher.find({
    enabled: true,
    archivedAt: null,
    nextRunAt: { $lte: now },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  }).sort({ nextRunAt: 1 });
}

export async function advanceWatcherNextRunAt(watcherId: string, nextRunAt: Date): Promise<void> {
  await Watcher.updateOne({ _id: watcherId }, { nextRunAt });
}

export async function recordWatcherObservation(
  watcherId: string,
  data: { newState: string; triggered: boolean },
): Promise<void> {
  const set: Record<string, unknown> = { lastState: data.newState };
  if (data.triggered) {
    set.lastFiredAt = new Date();
    await Watcher.updateOne({ _id: watcherId }, { $set: set, $inc: { fireCount: 1 } });
  } else {
    await Watcher.updateOne({ _id: watcherId }, { $set: set });
  }
}

/**
 * Update only `lastState` without touching fire counters. Used when a tick's
 * `triggered: true` outcome was demoted to a non-fire by cooldown or snooze,
 * or when the tick resulted in `triggered: false` and we just want to roll
 * forward the observation reference.
 */
export async function recordWatcherStateOnly(watcherId: string, newState: string): Promise<void> {
  await Watcher.updateOne({ _id: watcherId }, { $set: { lastState: newState } });
}

export async function requestManualWatcherRun(watcherId: string): Promise<IWatcher | null> {
  return Watcher.findByIdAndUpdate(
    watcherId,
    { manualRunRequestedAt: new Date() },
    { returnDocument: "after" },
  );
}

/**
 * Atomically claim the next pending manual-run request. Sets
 * `manualRunRequestedAt` back to null so it isn't picked up twice. Also skips
 * archived rows.
 */
export async function claimPendingManualWatcherRun(): Promise<IWatcher | null> {
  return Watcher.findOneAndUpdate(
    { manualRunRequestedAt: { $ne: null }, enabled: true, archivedAt: null },
    { manualRunRequestedAt: null },
    { sort: { manualRunRequestedAt: 1 }, returnDocument: "before" },
  );
}

// --- Watcher Log Helpers ---

export async function isWatcherRunning(watcherId: string): Promise<boolean> {
  const exists = await WatcherLog.exists({
    watcherId: new Types.ObjectId(watcherId),
    status: "running",
    startedAt: { $gte: new Date(Date.now() - STALE_RUNNING_THRESHOLD_MS) },
  });
  return exists !== null;
}

export async function createWatcherLog(
  watcherId: string,
  trigger: "cron" | "manual",
): Promise<IWatcherLog> {
  return WatcherLog.create({
    watcherId: new Types.ObjectId(watcherId),
    trigger,
    status: "running",
    startedAt: new Date(),
  });
}

export async function completeWatcherLog(
  logId: string,
  data: { triggered: boolean; suppressed?: boolean; summary: string; newState: string },
): Promise<void> {
  await WatcherLog.updateOne(
    { _id: logId },
    {
      status: "completed",
      triggered: data.triggered,
      suppressed: data.suppressed ?? false,
      summary: data.summary,
      newState: data.newState,
      completedAt: new Date(),
    },
  );
}

export async function failWatcherLog(logId: string, reason: string): Promise<void> {
  await WatcherLog.updateOne(
    { _id: logId },
    {
      status: "failed",
      summary: reason,
      completedAt: new Date(),
    },
  );
}

export async function getWatcherLogs(watcherId: string, limit = 50): Promise<IWatcherLog[]> {
  return WatcherLog.find({ watcherId: new Types.ObjectId(watcherId) })
    .sort({ startedAt: -1 })
    .limit(limit);
}

export async function cleanupOldWatcherLogs(olderThanDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await WatcherLog.deleteMany({
    status: { $ne: "running" },
    startedAt: { $lt: cutoff },
  });
  return result.deletedCount;
}

export async function resetStaleRunningWatcherLogs(): Promise<number> {
  const result = await WatcherLog.updateMany(
    {
      status: "running",
      startedAt: { $lt: new Date(Date.now() - STALE_RUNNING_THRESHOLD_MS) },
    },
    { status: "failed", summary: "Process crashed during execution", completedAt: new Date() },
  );
  return result.modifiedCount;
}
