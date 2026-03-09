import mongoose, { Schema, Types, type Document } from "mongoose";

// --- Workflow ---

export interface IWorkflow extends Document {
  chatId: string;
  name: string;
  prompt: string;
  cronSchedule: string;
  reportMode: "always" | "alert";
  enabled: boolean;
  nextRunAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const workflowSchema = new Schema<IWorkflow>(
  {
    chatId: { type: String, required: true },
    name: { type: String, required: true },
    prompt: { type: String, required: true },
    cronSchedule: { type: String, required: true },
    reportMode: { type: String, enum: ["always", "alert"], required: true },
    enabled: { type: Boolean, default: true },
    nextRunAt: { type: Date, required: true },
  },
  { timestamps: true },
);

workflowSchema.index({ chatId: 1 });
workflowSchema.index({ enabled: 1, nextRunAt: 1 });

export const Workflow =
  (mongoose.models.Workflow as mongoose.Model<IWorkflow>) ??
  mongoose.model<IWorkflow>("Workflow", workflowSchema);

// --- Workflow Log ---

export interface IWorkflowLog extends Document {
  workflowId: Types.ObjectId;
  status: "running" | "completed" | "failed";
  summary?: string;
  startedAt: Date;
  completedAt?: Date;
}

const workflowLogSchema = new Schema<IWorkflowLog>({
  workflowId: { type: Schema.Types.ObjectId, ref: "Workflow", required: true },
  status: { type: String, enum: ["running", "completed", "failed"], required: true },
  summary: { type: String },
  startedAt: { type: Date, required: true },
  completedAt: { type: Date },
});

workflowLogSchema.index({ workflowId: 1, startedAt: -1 });

export const WorkflowLog =
  (mongoose.models.WorkflowLog as mongoose.Model<IWorkflowLog>) ??
  mongoose.model<IWorkflowLog>("WorkflowLog", workflowLogSchema);

// --- Workflow Helpers ---

export interface WorkflowInput {
  name: string;
  prompt: string;
  cronSchedule: string;
  reportMode: "always" | "alert";
  nextRunAt: Date;
}

export async function createWorkflow(chatId: string, input: WorkflowInput): Promise<IWorkflow> {
  return Workflow.create({ chatId, ...input });
}

export async function listWorkflowsForChat(chatId: string): Promise<IWorkflow[]> {
  return Workflow.find({ chatId }).sort({ createdAt: -1 });
}

export async function getWorkflowById(
  workflowId: string,
  chatId?: string,
): Promise<IWorkflow | null> {
  const filter: Record<string, unknown> = { _id: workflowId };
  if (chatId) filter.chatId = chatId;
  return Workflow.findOne(filter);
}

export async function updateWorkflow(
  workflowId: string,
  patch: Partial<
    Pick<IWorkflow, "name" | "prompt" | "cronSchedule" | "reportMode" | "enabled" | "nextRunAt">
  >,
  chatId?: string,
): Promise<IWorkflow | null> {
  const filter: Record<string, unknown> = { _id: workflowId };
  if (chatId) filter.chatId = chatId;
  return Workflow.findOneAndUpdate(filter, patch, { new: true });
}

export async function deleteWorkflow(workflowId: string, chatId?: string): Promise<boolean> {
  const filter: Record<string, unknown> = { _id: workflowId };
  if (chatId) filter.chatId = chatId;
  const result = await Workflow.findOneAndDelete(filter);
  if (result) {
    await WorkflowLog.deleteMany({ workflowId: new Types.ObjectId(workflowId) });
  }
  return result !== null;
}

export async function getDueWorkflows(): Promise<IWorkflow[]> {
  return Workflow.find({
    enabled: true,
    nextRunAt: { $lte: new Date() },
  }).sort({ nextRunAt: 1 });
}

export async function advanceNextRunAt(workflowId: string, nextRunAt: Date): Promise<void> {
  await Workflow.findByIdAndUpdate(workflowId, { nextRunAt });
}

// --- Workflow Log Helpers ---

const STALE_RUNNING_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes — must exceed realistic execution time

export async function isWorkflowRunning(workflowId: string): Promise<boolean> {
  const exists = await WorkflowLog.exists({
    workflowId: new Types.ObjectId(workflowId),
    status: "running",
    startedAt: { $gte: new Date(Date.now() - STALE_RUNNING_THRESHOLD_MS) },
  });
  return exists !== null;
}

export async function createWorkflowLog(workflowId: string): Promise<IWorkflowLog> {
  return WorkflowLog.create({
    workflowId: new Types.ObjectId(workflowId),
    status: "running",
    startedAt: new Date(),
  });
}

export async function completeWorkflowLog(logId: string, summary: string): Promise<void> {
  await WorkflowLog.findByIdAndUpdate(logId, {
    status: "completed",
    summary,
    completedAt: new Date(),
  });
}

export async function failWorkflowLog(logId: string, reason: string): Promise<void> {
  await WorkflowLog.findByIdAndUpdate(logId, {
    status: "failed",
    summary: reason,
    completedAt: new Date(),
  });
}

export async function getWorkflowLogs(workflowId: string, limit = 50): Promise<IWorkflowLog[]> {
  return WorkflowLog.find({ workflowId: new Types.ObjectId(workflowId) })
    .sort({ startedAt: -1 })
    .limit(limit);
}

export async function cleanupOldWorkflowLogs(olderThanDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await WorkflowLog.deleteMany({
    status: { $ne: "running" },
    startedAt: { $lt: cutoff },
  });
  return result.deletedCount;
}

export async function resetStaleRunningLogs(): Promise<number> {
  const result = await WorkflowLog.updateMany(
    {
      status: "running",
      startedAt: { $lt: new Date(Date.now() - STALE_RUNNING_THRESHOLD_MS) },
    },
    { status: "failed", summary: "Process crashed during execution", completedAt: new Date() },
  );
  return result.modifiedCount;
}
