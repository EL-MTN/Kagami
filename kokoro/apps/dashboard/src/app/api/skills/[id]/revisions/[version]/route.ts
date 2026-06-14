import { NextResponse } from "next/server";
import { z } from "zod";
import { getSkillById, getSkillRevision, updateSkillIfVersionWithHistory } from "@kokoro/db";
import { ensureDB } from "@/lib/db";
import { getSkillDetail } from "@/lib/queries/skills";
import mongoose from "mongoose";

type RouteParams = { params: Promise<{ id: string; version: string }> };

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

// The version the history page was rendered at. The restore CASes on THIS, not a
// fresh re-read, so a restore confirmed from a stale page (the skill moved on
// since it loaded) returns 409 instead of overwriting the intervening edit.
const restoreBodySchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
});

/**
 * Restore a skill's content to one of its superseded versions. Rollback is just
 * another content edit: it snapshots the now-current version first (so the
 * rollback is itself undoable) and writes the old content as a new version
 * through the same history-aware compare-and-set the curator uses. Only the
 * content fields move — the name (stable handle) and enabled state are left as
 * they are, so an ARCHIVED skill's content can be rolled back while it stays
 * archived (`requireEnabled: false`). A direct operator action, so no approval
 * bubble.
 */
export async function POST(request: Request, { params }: RouteParams) {
  const { id, version } = await params;
  if (!isValidObjectId(id)) {
    return NextResponse.json({ error: "Invalid skill ID" }, { status: 400 });
  }
  const targetVersion = Number(version);
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    return NextResponse.json({ error: "Invalid version" }, { status: 400 });
  }

  const parsedBody = restoreBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json({ error: "expectedVersion is required" }, { status: 400 });
  }
  const { expectedVersion } = parsedBody.data;

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
    expectedVersion,
    {
      description: revision.description,
      body: revision.body,
      triggers: revision.triggers,
      tags: revision.tags,
    },
    { reason: "rollback", actor: "dashboard", note: `Restored v${targetVersion}` },
    // Operator action: allow restoring an archived skill's content (it stays
    // archived). The CAS still guards on `expectedVersion`, so a concurrent edit
    // is rejected, not clobbered.
    { requireEnabled: false },
  );

  if (!restored) {
    // The CAS guards on the page's `expectedVersion`, so this means the skill
    // changed (or was deleted) between loading the history and confirming.
    return NextResponse.json(
      { error: "Skill changed since the history was loaded — reload and try again" },
      { status: 409 },
    );
  }

  const detail = await getSkillDetail(id);
  return NextResponse.json({ skill: detail });
}
