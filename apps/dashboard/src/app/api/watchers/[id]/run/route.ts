import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { getWatcherById, requestManualWatcherRun } from "@mashiro/db";
import { ensureDB } from "@/lib/db";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid watcher ID" }, { status: 400 });
  }

  await ensureDB();

  const watcher = await getWatcherById(id);
  if (!watcher) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!watcher.enabled) {
    return NextResponse.json({ error: "Watcher is disabled" }, { status: 409 });
  }
  if (watcher.archivedAt) {
    return NextResponse.json({ error: "Watcher is archived" }, { status: 409 });
  }
  if (watcher.manualRunRequestedAt) {
    return NextResponse.json(
      { error: "A run is already queued for this watcher" },
      { status: 409 },
    );
  }

  const updated = await requestManualWatcherRun(id);
  return NextResponse.json({
    ok: true,
    requestedAt: updated?.manualRunRequestedAt?.toISOString() ?? null,
  });
}
