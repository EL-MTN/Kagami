import { Watcher, WatcherLog } from "@mashiro/db";
import { ensureDB } from "../db";
import type { WatcherListItem, WatcherLogItem } from "../watcher-schema";

interface LastLog {
  status: string;
  triggered: boolean | null;
  suppressed?: boolean;
  startedAt: Date;
  completedAt?: Date | null;
}

interface WatcherDoc {
  _id: { toString(): string };
  chatId: string;
  name: string;
  description: string;
  prompt: string;
  cronSchedule: string;
  enabled: boolean;
  version: number;
  fireCount: number;
  lastFiredAt: Date | null;
  nextRunAt: Date | null;
  expiresAt: Date | null;
  archivedAt: Date | null;
  oneShot: boolean;
  maxFires: number | null;
  cooldownMs: number | null;
  snoozedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toWatcherListItem(w: WatcherDoc, lastLog?: LastLog): WatcherListItem {
  return {
    id: w._id.toString(),
    chatId: w.chatId,
    name: w.name,
    description: w.description,
    prompt: w.prompt,
    cronSchedule: w.cronSchedule,
    enabled: w.enabled,
    version: w.version,
    fireCount: w.fireCount ?? 0,
    lastFiredAt: w.lastFiredAt?.toISOString() ?? null,
    nextRunAt: w.nextRunAt?.toISOString() ?? null,
    expiresAt: w.expiresAt?.toISOString() ?? null,
    archivedAt: w.archivedAt?.toISOString() ?? null,
    // Coalesce against legacy v1 rows: `.lean()` skips Mongoose's schema
    // defaults, so pre-Phase-A docs may have these fields absent.
    oneShot: w.oneShot ?? false,
    maxFires: w.maxFires ?? null,
    cooldownMs: w.cooldownMs ?? null,
    snoozedUntil: w.snoozedUntil?.toISOString() ?? null,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
    lastRun: lastLog
      ? {
          status: lastLog.status as "running" | "completed" | "failed",
          triggered: lastLog.triggered ?? null,
          suppressed: lastLog.suppressed ?? false,
          startedAt: lastLog.startedAt.toISOString(),
          completedAt: lastLog.completedAt?.toISOString() ?? undefined,
        }
      : undefined,
  };
}

export async function getWatcherList(): Promise<WatcherListItem[]> {
  await ensureDB();

  const watchers = await Watcher.find().sort({ createdAt: -1 }).limit(200).lean();

  const watcherIds = watchers.map((w) => w._id);
  const lastLogs = await WatcherLog.aggregate<{ _id: unknown; doc: LastLog }>([
    { $match: { watcherId: { $in: watcherIds } } },
    { $sort: { startedAt: -1 } },
    { $group: { _id: "$watcherId", doc: { $first: "$$ROOT" } } },
  ]);
  const lastLogMap = new Map(lastLogs.map((l) => [String(l._id), l.doc]));

  return watchers.map((w) => toWatcherListItem(w, lastLogMap.get(w._id.toString())));
}

export async function getWatcherDetail(id: string): Promise<WatcherListItem | null> {
  await ensureDB();

  const w = await Watcher.findById(id).lean();
  if (!w) return null;

  const lastLog = await WatcherLog.findOne({ watcherId: w._id }).sort({ startedAt: -1 }).lean();
  return toWatcherListItem(w, lastLog ?? undefined);
}

export async function getWatcherLogList(
  watcherId: string,
  limit = 50,
  before?: string,
): Promise<{ logs: WatcherLogItem[]; hasMore: boolean }> {
  await ensureDB();

  const filter: Record<string, unknown> = { watcherId };
  if (before) {
    filter.startedAt = { $lt: new Date(before) };
  }

  const logs = await WatcherLog.find(filter)
    .sort({ startedAt: -1 })
    .limit(limit + 1)
    .lean();

  const hasMore = logs.length > limit;
  const items = logs.slice(0, limit);

  return {
    logs: items.map((l) => ({
      id: l._id.toString(),
      trigger: l.trigger,
      status: l.status,
      triggered: l.triggered ?? null,
      suppressed: l.suppressed ?? false,
      summary: l.summary,
      newState: l.newState,
      startedAt: l.startedAt.toISOString(),
      completedAt: l.completedAt?.toISOString(),
    })),
    hasMore,
  };
}
