import { NextResponse } from "next/server";
import { CronExpressionParser } from "cron-parser";
import { getSkillById, updateSkill, deleteSkill } from "@mashiro/db";
import { ensureDB } from "@/lib/db";
import { getSkillDetail } from "@/lib/queries/skills";
import { skillPatchSchema } from "@/lib/skill-schema";
import mongoose from "mongoose";

type RouteParams = { params: Promise<{ id: string }> };

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
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
  if (data.prompt !== undefined) patch.prompt = data.prompt;
  if (data.reportMode !== undefined) patch.reportMode = data.reportMode;
  if (data.enabled !== undefined) patch.enabled = data.enabled;
  if (data.parameters !== undefined) patch.parameters = data.parameters;

  if (data.cronSchedule !== undefined) {
    if (data.cronSchedule) {
      try {
        CronExpressionParser.parse(data.cronSchedule);
      } catch {
        return NextResponse.json(
          {
            error: `Invalid cron expression: "${data.cronSchedule}"`,
          },
          { status: 400 },
        );
      }

      // Validate required params have defaults
      const params = data.parameters ?? existing.parameters;
      const missingDefaults = params.filter((p) => p.required && p.default === undefined);
      if (missingDefaults.length > 0) {
        return NextResponse.json(
          {
            error: `Cron-scheduled skills require defaults for all required parameters. Missing: ${missingDefaults.map((p) => p.name).join(", ")}`,
          },
          { status: 400 },
        );
      }

      patch.cronSchedule = data.cronSchedule;
      patch.nextRunAt = CronExpressionParser.parse(data.cronSchedule).next().toDate();
    } else {
      patch.cronSchedule = null;
      patch.nextRunAt = null;
    }
  }

  // Always increment version
  patch.version = existing.version + 1;

  try {
    const updated = await updateSkill(id, patch);
    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const detail = await getSkillDetail(id);
    return NextResponse.json({ skill: detail });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code: number }).code === 11000) {
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

  return NextResponse.json({ ok: true });
}
