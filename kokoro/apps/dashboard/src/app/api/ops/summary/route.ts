import { NextResponse } from "next/server";
import { PendingConfirmation, Routine, RoutineLog, Watcher, WatcherLog } from "@kokoro/db";
import { ensureDB } from "@/lib/db";

const FAILURE_LIMIT = 5;
const STALE_CONFIRMATION_MS = 60 * 60 * 1000;

interface LogDoc {
  _id: { toString(): string };
  routineId?: { toString(): string };
  watcherId?: { toString(): string };
  status: "running" | "completed" | "failed";
  summary?: string | null;
  startedAt: Date;
}

interface OwnerDoc {
  _id: { toString(): string };
  name: string;
}

function serializeFailure(doc: LogDoc, names: Map<string, string>, key: "routineId" | "watcherId") {
  const ownerId = doc[key]?.toString();
  return {
    id: doc._id.toString(),
    ownerId: ownerId ?? null,
    name: ownerId ? (names.get(ownerId) ?? null) : null,
    summary: doc.summary ?? null,
    startedAt: doc.startedAt.toISOString(),
  };
}

function ownerNameMap(docs: OwnerDoc[]): Map<string, string> {
  return new Map(docs.map((doc) => [doc._id.toString(), doc.name]));
}

async function latestFailedRoutineLogs(ownerIds: Array<{ toString(): string }>): Promise<LogDoc[]> {
  if (ownerIds.length === 0) return [];
  return RoutineLog.aggregate<LogDoc>([
    { $match: { routineId: { $in: ownerIds } } },
    { $sort: { startedAt: -1, _id: -1 } },
    { $group: { _id: "$routineId", doc: { $first: "$$ROOT" } } },
    { $replaceRoot: { newRoot: "$doc" } },
    { $match: { status: "failed" } },
    { $sort: { startedAt: -1, _id: -1 } },
    { $limit: FAILURE_LIMIT },
    { $project: { _id: 1, routineId: 1, status: 1, summary: 1, startedAt: 1 } },
  ]);
}

async function latestFailedWatcherLogs(ownerIds: Array<{ toString(): string }>): Promise<LogDoc[]> {
  if (ownerIds.length === 0) return [];
  return WatcherLog.aggregate<LogDoc>([
    { $match: { watcherId: { $in: ownerIds } } },
    { $sort: { startedAt: -1, _id: -1 } },
    { $group: { _id: "$watcherId", doc: { $first: "$$ROOT" } } },
    { $replaceRoot: { newRoot: "$doc" } },
    { $match: { status: "failed" } },
    { $sort: { startedAt: -1, _id: -1 } },
    { $limit: FAILURE_LIMIT },
    { $project: { _id: 1, watcherId: 1, status: 1, summary: 1, startedAt: 1 } },
  ]);
}

export async function GET() {
  await ensureDB();

  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_CONFIRMATION_MS);

  const [pendingConfirmations, staleConfirmations, enabledRoutineDocs, enabledWatcherDocs] =
    await Promise.all([
      PendingConfirmation.countDocuments({ status: "pending", expiresAt: { $gt: now } }),
      PendingConfirmation.countDocuments({
        status: "pending",
        expiresAt: { $gt: now },
        createdAt: { $lt: staleCutoff },
      }),
      Routine.find({ enabled: true }).select("name").lean<OwnerDoc[]>(),
      Watcher.find({ enabled: true, archivedAt: null }).select("name").lean<OwnerDoc[]>(),
    ]);

  const [failedRoutineLogs, failedWatcherLogs] = await Promise.all([
    latestFailedRoutineLogs(enabledRoutineDocs.map((routine) => routine._id)),
    latestFailedWatcherLogs(enabledWatcherDocs.map((watcher) => watcher._id)),
  ]);

  const routineNameMap = ownerNameMap(enabledRoutineDocs);
  const watcherNameMap = ownerNameMap(enabledWatcherDocs);

  return NextResponse.json({
    generatedAt: now.toISOString(),
    pendingConfirmations,
    staleConfirmations,
    enabledRoutines: enabledRoutineDocs.length,
    enabledWatchers: enabledWatcherDocs.length,
    failedRoutines: failedRoutineLogs.map((log) =>
      serializeFailure(log, routineNameMap, "routineId"),
    ),
    failedWatchers: failedWatcherLogs.map((log) =>
      serializeFailure(log, watcherNameMap, "watcherId"),
    ),
  });
}
