import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { getSkillById, requestManualRun } from "@mashiro/db";
import { ensureDB } from "@/lib/db";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid skill ID" }, { status: 400 });
  }

  await ensureDB();

  const skill = await getSkillById(id);
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!skill.enabled) {
    return NextResponse.json({ error: "Skill is disabled" }, { status: 409 });
  }
  if (skill.manualRunRequestedAt) {
    return NextResponse.json(
      { error: "A run is already queued for this skill" },
      { status: 409 },
    );
  }

  const updated = await requestManualRun(id);
  return NextResponse.json({
    ok: true,
    requestedAt: updated?.manualRunRequestedAt?.toISOString() ?? null,
  });
}
