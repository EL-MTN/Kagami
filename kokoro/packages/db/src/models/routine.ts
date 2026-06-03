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
  id: string;
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
  id: string;
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

/**
 * A cron routine in `alert` reportMode returns exactly this when nothing was
 * noteworthy — a *successful* run that intentionally produces no report. Shared
 * with the routine executor (which writes it) and the health helper (which must
 * not count it as an empty/failed run). Single source of truth.
 */
export const NO_REPORT_SENTINEL = "[no report]";

// --- Routine Health ---

/**
 * Per-routine execution health over its most recent runs. Reports *facts only*
 * — counts of failed / empty / no-report runs — never a verdict on whether a
 * routine "needs fixing". That judgment belongs to the LLM: the conversational
 * model sees these numbers in its routine context and may offer a refinement,
 * and the self-review pass uses them only as a pre-filter for which routines to
 * ask the model about.
 */
export interface RoutineHealth {
  routineId: string;
  name: string;
  /** Number of recent runs considered. */
  window: number;
  totalRuns: number;
  failedRuns: number;
  /** Completed but produced a blank summary. */
  emptyRuns: number;
  /** Completed with the `[no report]` sentinel (expected for alert-mode cron). */
  noReportRuns: number;
  lastStatus: "completed" | "failed" | null;
  /** Summary of the most recent failed run, if the latest run failed. */
  lastError?: string;
  lastRunAt?: Date;
}

const HEALTH_WINDOW_DEFAULT = 10;

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
  return Routine.findOneAndUpdate(filter, patch, { returnDocument: "after" });
}

/**
 * Atomically apply a routine edit only if its version still equals
 * `expectedVersion`, bumping the version on success. Closes the read-then-write
 * race in the gated dispatcher: a concurrent edit landing between the proposal's
 * version check and this write is rejected (returns null) rather than silently
 * clobbered. Returns the updated doc, or null if the routine is gone OR its
 * version moved on — the caller distinguishes the two via an existence check.
 */
export async function updateRoutineIfVersion(
  routineId: string,
  chatId: string,
  expectedVersion: number,
  patch: Partial<Pick<IRoutine, "prompt" | "parameters" | "enabled">>,
): Promise<IRoutine | null> {
  return Routine.findOneAndUpdate(
    { _id: routineId, chatId, version: expectedVersion },
    { ...patch, version: expectedVersion + 1 },
    { returnDocument: "after" },
  );
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
  await Routine.updateOne({ _id: routineId }, { nextRunAt });
}

export async function requestManualRun(routineId: string): Promise<IRoutine | null> {
  return Routine.findByIdAndUpdate(
    routineId,
    { manualRunRequestedAt: new Date() },
    { returnDocument: "after" },
  );
}

/**
 * Atomically claim the next pending manual-run request. Sets
 * `manualRunRequestedAt` back to null so this won't be picked up twice.
 */
export async function claimPendingManualRun(): Promise<IRoutine | null> {
  return Routine.findOneAndUpdate(
    { manualRunRequestedAt: { $ne: null }, enabled: true },
    { manualRunRequestedAt: null },
    { sort: { manualRunRequestedAt: 1 }, returnDocument: "before" },
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
  await RoutineLog.updateOne(
    { _id: logId },
    {
      status: "completed",
      summary,
      completedAt: new Date(),
    },
  );
}

export async function failRoutineLog(logId: string, reason: string): Promise<void> {
  await RoutineLog.updateOne(
    { _id: logId },
    {
      status: "failed",
      summary: reason,
      completedAt: new Date(),
    },
  );
}

export async function getRoutineLogs(
  routineId: string,
  limit = 50,
  opts: { excludeComposed?: boolean; excludeRunning?: boolean } = {},
): Promise<IRoutineLog[]> {
  const filter: Record<string, unknown> = { routineId: new Types.ObjectId(routineId) };
  // Push the filters into the query so callers that want only real, finished
  // runs (the self-review pass) get them within the limit window, instead of
  // limiting first and dropping rows after — which can leave nothing behind.
  if (opts.excludeComposed) filter.trigger = { $ne: "routine" };
  if (opts.excludeRunning) filter.status = { $ne: "running" };
  // `_id` breaks startedAt ties so "newest" is deterministic — ObjectIds are
  // monotonic within a process, so the most-recently-inserted run wins even when
  // two share a millisecond.
  return RoutineLog.find(filter).sort({ startedAt: -1, _id: -1 }).limit(limit);
}

/**
 * Recent execution health for every enabled routine in a chat. Sub-runs invoked
 * via useRoutine (`trigger: "routine"`) are excluded so a parent routine's
 * composed calls don't double-count against it; in-flight ("running") logs are
 * skipped so a mid-execution tick doesn't skew the window. Returns facts only —
 * see `RoutineHealth`.
 */
export async function getRoutineHealth(
  chatId: string,
  opts: { window?: number } = {},
): Promise<RoutineHealth[]> {
  const window = opts.window ?? HEALTH_WINDOW_DEFAULT;
  const routines = await Routine.find({ chatId, enabled: true }).sort({ createdAt: -1 });

  return Promise.all(
    routines.map(async (routine) => {
      // Same filter + sort the self-review pass uses (via getRoutineLogs) so the
      // health counts and the runs shown to the review LLM can never diverge.
      const logs = await getRoutineLogs(routine._id.toString(), window, {
        excludeComposed: true,
        excludeRunning: true,
      });

      // An alert-mode routine legitimately produces nothing on a quiet run, and
      // only cron runs get the explicit `[no report]` sentinel instruction — a
      // manual run, or a cron run where the model omits the literal, completes
      // with a blank summary. Treat a blank completion as a (healthy) no-report
      // for alert-mode routines so quiet runs don't look like failures; for
      // always-report routines a blank completion is genuinely suspicious (it
      // was supposed to report something), so it stays an emptyRun.
      const alert = routine.reportMode === "alert";
      let failedRuns = 0;
      let emptyRuns = 0;
      let noReportRuns = 0;
      for (const log of logs) {
        if (log.status === "failed") {
          failedRuns++;
          continue;
        }
        const summary = (log.summary ?? "").trim();
        const isSentinel = summary.toLowerCase() === NO_REPORT_SENTINEL.toLowerCase();
        if (isSentinel || (alert && summary.length === 0)) noReportRuns++;
        else if (summary.length === 0) emptyRuns++;
        // a non-empty real report → healthy, uncounted
      }

      const latest = logs[0];
      return {
        routineId: routine._id.toString(),
        name: routine.name,
        window,
        totalRuns: logs.length,
        failedRuns,
        emptyRuns,
        noReportRuns,
        lastStatus: latest ? (latest.status as "completed" | "failed") : null,
        lastError: latest && latest.status === "failed" ? (latest.summary ?? undefined) : undefined,
        lastRunAt: latest?.startedAt,
      };
    }),
  );
}

// Shared "is this routine underperforming" thresholds. `MIN_REAL_RUNS_TO_FLAG`
// guards against judging on too little signal.
const MIN_REAL_RUNS_TO_FLAG = 4;
const BAD_RATE_THRESHOLD = 0.5;

/**
 * Whether a routine's recent record is bad enough to surface (a ⚠ annotation in
 * chat) and spend an LLM self-review on. Counts only *real* attempts: runs that
 * legitimately produced nothing (`noReportRuns`) are excluded from BOTH the
 * numerator and the denominator — so a quiet alert-mode routine never trips it,
 * and a routine that failed every real attempt isn't diluted into looking
 * healthy by its quiet runs. Single source of truth shared by the chat
 * annotation (`context-assembler`) and the self-review pass (`routine-review`)
 * so the two surfaces can't disagree at the threshold boundary.
 */
export function routineNeedsAttention(h: RoutineHealth): boolean {
  const realRuns = h.totalRuns - h.noReportRuns;
  if (realRuns < MIN_REAL_RUNS_TO_FLAG) return false;
  return (h.failedRuns + h.emptyRuns) / realRuns >= BAD_RATE_THRESHOLD;
}

/**
 * Distinct chatIds that currently own at least one enabled routine. The
 * self-review scheduler uses this to enumerate which chats to audit (no other
 * scheduler keeps a chat list — routines are the source of truth).
 */
export async function listChatIdsWithRoutines(): Promise<string[]> {
  return Routine.distinct("chatId", { enabled: true });
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
