import { NextResponse } from "next/server";
import { getSkillById, getSkillRevision, updateSkillIfVersionWithHistory } from "@kokoro/db";
import { ensureDB } from "@/lib/db";
import { getSkillDetail } from "@/lib/queries/skills";
import mongoose from "mongoose";

type RouteParams = { params: Promise<{ id: string; version: string }> };

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

/**
 * Restore a skill's content to one of its superseded versions. Rollback is just
 * another content edit: it snapshots the now-current version first (so the
 * rollback is itself undoable) and writes the old content as a new version
 * through the same history-aware compare-and-set the curator uses. Only the
 * content fields move — the name (stable handle) and enabled state are left as
 * they are. A direct operator action, so no approval bubble.
 */
export async function POST(_request: Request, { params }: RouteParams) {
  const { id, version } = await params;
  if (!isValidObjectId(id)) {
    return NextResponse.json({ error: "Invalid skill ID" }, { status: 400 });
  }
  const targetVersion = Number(version);
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    return NextResponse.json({ error: "Invalid version" }, { status: 400 });
  }

  await ensureDB();

  const live = await getSkillById(id);
  if (!live) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const revision = await getSkillRevision(id, live.chatId, targetVersion);
  if (!revision) {
    return NextResponse.json({ error: "Revision not found" }, { status: 404 });
  }

  const restored = await updateSkillIfVersionWithHistory(
    id,
    live.chatId,
    live.version,
    {
      description: revision.description,
      body: revision.body,
      triggers: revision.triggers,
      tags: revision.tags,
    },
    { reason: "rollback", actor: "dashboard", note: `Restored v${targetVersion}` },
  );

  if (!restored) {
    // The CAS requires the skill still be at `live.version` and enabled — it
    // changed or was archived between the read and the write.
    return NextResponse.json(
      { error: "Skill changed or is archived — reload and try again" },
      { status: 409 },
    );
  }

  const detail = await getSkillDetail(id);
  return NextResponse.json({ skill: detail });
}
