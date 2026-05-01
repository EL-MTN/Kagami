import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { getRoutineById, requestManualRun } from "@mashiro/db";
import { ensureDB } from "@/lib/db";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid routine ID" }, { status: 400 });
  }

  await ensureDB();

  const routine = await getRoutineById(id);
  if (!routine) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!routine.enabled) {
    return NextResponse.json({ error: "Routine is disabled" }, { status: 409 });
  }
  if (routine.manualRunRequestedAt) {
    return NextResponse.json(
      { error: "A run is already queued for this routine" },
      { status: 409 },
    );
  }

  const updated = await requestManualRun(id);
  return NextResponse.json({
    ok: true,
    requestedAt: updated?.manualRunRequestedAt?.toISOString() ?? null,
  });
}
