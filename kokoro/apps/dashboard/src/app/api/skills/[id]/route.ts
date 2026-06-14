import { NextResponse } from "next/server";
import {
  getSkillById,
  updateSkill,
  deleteSkill,
  deleteSkillRevisions,
  snapshotSkillVersion,
  isDuplicateKeyError,
} from "@kokoro/db";
import { ensureDB } from "@/lib/db";
import { getSkillDetail } from "@/lib/queries/skills";
import { skillPatchSchema } from "@/lib/skill-schema";
import mongoose from "mongoose";

type RouteParams = { params: Promise<{ id: string }> };

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

function editsVersionedFields(patch: Record<string, unknown>): boolean {
  return ["name", "description", "body", "triggers", "tags", "source", "linkedRoutineIds"].some(
    (key) => patch[key] !== undefined,
  );
}

// A manual content edit overwrites the live skill in place — snapshot the
// pre-edit version to history first so it stays recoverable, exactly as the
// curator's gated edits do. Metadata-only changes (name / source / links) and
// the enabled toggle change no content, so they are not recorded.
function editsContentFields(patch: Record<string, unknown>): boolean {
  return ["description", "body", "triggers", "tags"].some((key) => patch[key] !== undefined);
}

export async function GET(_request: Request, { params }: RouteParams) {
  const { id } = await params;
  if (!isValidObjectId(id)) {
    return NextResponse.json({ error: "Invalid skill ID" }, { status: 400 });
  }

  await ensureDB();
  const skill = await getSkillDetail(id);

  if (!skill) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ skill });
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { id } = await params;
  if (!isValidObjectId(id)) {
    return NextResponse.json({ error: "Invalid skill ID" }, { status: 400 });
  }

  const body: unknown = await request.json();
  const parsed = skillPatchSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  await ensureDB();

  const existing = await getSkillById(id);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const patch: Record<string, unknown> = {};
  const data = parsed.data;
  if (data.name !== undefined) patch.name = data.name;
  if (data.description !== undefined) patch.description = data.description;
  if (data.body !== undefined) patch.body = data.body;
  if (data.triggers !== undefined) patch.triggers = data.triggers;
  if (data.tags !== undefined) patch.tags = data.tags;
  if (data.enabled !== undefined) patch.enabled = data.enabled;
  if (data.source !== undefined) patch.source = data.source;
  if (data.linkedRoutineIds !== undefined) patch.linkedRoutineIds = data.linkedRoutineIds;
  if (editsVersionedFields(patch)) patch.version = existing.version + 1;

  try {
    const updated = await updateSkill(id, patch);
    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Snapshot the pre-edit version to history only AFTER the update lands, so a
    // rejected PATCH — e.g. a rename hitting the unique (chatId, name) index,
    // which throws below — never leaves a bogus revision for the still-live
    // version. `existing` still holds the pre-edit content.
    if (editsContentFields(patch)) {
      await snapshotSkillVersion(
        {
          skillId: existing.id,
          chatId: existing.chatId,
          version: existing.version,
          name: existing.name,
          description: existing.description,
          body: existing.body,
          triggers: existing.triggers,
          tags: existing.tags,
        },
        { reason: "manual-edit", actor: "dashboard" },
      );
    }

    const detail = await getSkillDetail(id);
    return NextResponse.json({ skill: detail });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return NextResponse.json({ error: "A skill with that name already exists" }, { status: 409 });
    }
    throw error;
  }
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const { id } = await params;
  if (!isValidObjectId(id)) {
    return NextResponse.json({ error: "Invalid skill ID" }, { status: 400 });
  }

  await ensureDB();
  const deleted = await deleteSkill(id);

  if (!deleted) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Hard delete is rare (archive is the norm and leaves history intact); when it
  // happens, drop the orphaned revisions too.
  await deleteSkillRevisions(id);

  return NextResponse.json({ ok: true });
}
