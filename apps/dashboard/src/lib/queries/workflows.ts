import { Workflow, WorkflowLog } from "@mashiro/db";
import { ensureDB } from "../db";

export interface WorkflowListItem {
  id: string;
  chatId: string;
  name: string;
  prompt: string;
  cronSchedule: string;
  reportMode: "always" | "alert";
  enabled: boolean;
  nextRunAt: Date;
  createdAt: Date;
  lastRun?: {
    status: "running" | "completed" | "failed";
    startedAt: Date;
    completedAt?: Date;
  };
}

export interface WorkflowLogItem {
  id: string;
  status: "running" | "completed" | "failed";
  summary?: string;
  startedAt: Date;
  completedAt?: Date;
}

export async function getWorkflowList(): Promise<WorkflowListItem[]> {
  await ensureDB();

  const workflows = await Workflow.find().sort({ createdAt: -1 }).limit(100).lean();

  // Batch-fetch last log for all workflows in one query
  const workflowIds = workflows.map((w) => w._id);
  const lastLogs = await WorkflowLog.aggregate<{
    _id: unknown;
    doc: { status: string; startedAt: Date; completedAt?: Date };
  }>([
    { $match: { workflowId: { $in: workflowIds } } },
    { $sort: { startedAt: -1 } },
    { $group: { _id: "$workflowId", doc: { $first: "$$ROOT" } } },
  ]);
  const lastLogMap = new Map(lastLogs.map((l) => [String(l._id), l.doc]));

  return workflows.map((w) => {
    const lastLog = lastLogMap.get(w._id.toString());
    return {
      id: w._id.toString(),
      chatId: w.chatId,
      name: w.name,
      prompt: w.prompt,
      cronSchedule: w.cronSchedule,
      reportMode: w.reportMode,
      enabled: w.enabled,
      nextRunAt: w.nextRunAt,
      createdAt: w.createdAt,
      lastRun: lastLog
        ? {
            status: lastLog.status as "running" | "completed" | "failed",
            startedAt: lastLog.startedAt,
            completedAt: lastLog.completedAt,
          }
        : undefined,
    };
  });
}

export async function getWorkflowHistory(
  workflowId: string,
): Promise<{ workflow: WorkflowListItem | null; logs: WorkflowLogItem[] }> {
  await ensureDB();

  const w = await Workflow.findById(workflowId).lean();
  if (!w) return { workflow: null, logs: [] };

  const logs = await WorkflowLog.find({ workflowId: w._id })
    .sort({ startedAt: -1 })
    .limit(50)
    .lean();

  return {
    workflow: {
      id: w._id.toString(),
      chatId: w.chatId,
      name: w.name,
      prompt: w.prompt,
      cronSchedule: w.cronSchedule,
      reportMode: w.reportMode,
      enabled: w.enabled,
      nextRunAt: w.nextRunAt,
      createdAt: w.createdAt,
    },
    logs: logs.map((l) => ({
      id: l._id.toString(),
      status: l.status,
      summary: l.summary,
      startedAt: l.startedAt,
      completedAt: l.completedAt,
    })),
  };
}
