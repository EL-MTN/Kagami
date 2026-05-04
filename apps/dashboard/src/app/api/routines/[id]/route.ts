import { NextResponse } from "next/server";
import { getRoutineById, updateRoutine, deleteRoutine, isDuplicateKeyError } from "@kokoro/db";
import { computeNextRunAt, validateCronAndDefaults } from "@kokoro/shared";
import { ensureDB } from "@/lib/db";
import { getRoutineDetail } from "@/lib/queries/routines";
import { routinePatchSchema } from "@/lib/routine-schema";
import mongoose from "mongoose";

type RouteParams = { params: Promise<{ id: string }> };

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

export async function GET(_request: Request, { params }: RouteParams) {
  const { id } = await params;
  if (!isValidObjectId(id)) {
    return NextResponse.json({ error: "Invalid routine ID" }, { status: 400 });
  }

  await ensureDB();
  const routine = await getRoutineDetail(id);

  if (!routine) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ routine });
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { id } = await params;
  if (!isValidObjectId(id)) {
    return NextResponse.json({ error: "Invalid routine ID" }, { status: 400 });
  }

  const body: unknown = await request.json();
  const parsed = routinePatchSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  await ensureDB();

  const existing = await getRoutineById(id);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const patch: Record<string, unknown> = {};
  const data = parsed.data;

  if (data.name !== undefined) patch.name = data.name;
  if (data.description !== undefined) patch.description = data.description;
  if (data.prompt !== undefined) patch.prompt = data.prompt;
  if (data.reportMode !== undefined) patch.reportMode = data.reportMode;
  if (data.purity !== undefined) patch.purity = data.purity;
  if (data.enabled !== undefined) patch.enabled = data.enabled;
  if (data.parameters !== undefined) patch.parameters = data.parameters;

  if (data.cronSchedule !== undefined) {
    if (data.cronSchedule) {
      const params = data.parameters ?? existing.parameters;
      const cronErr = validateCronAndDefaults(data.cronSchedule, params);
      if (cronErr) {
        return NextResponse.json({ error: cronErr.message }, { status: 400 });
      }
      patch.cronSchedule = data.cronSchedule;
      patch.nextRunAt = computeNextRunAt(data.cronSchedule);
    } else {
      patch.cronSchedule = null;
      patch.nextRunAt = null;
    }
  }

  // Always increment version
  patch.version = existing.version + 1;

  try {
    const updated = await updateRoutine(id, patch);
    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const detail = await getRoutineDetail(id);
    return NextResponse.json({ routine: detail });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return NextResponse.json(
        { error: "A routine with that name already exists" },
        { status: 409 },
      );
    }
    throw error;
  }
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const { id } = await params;
  if (!isValidObjectId(id)) {
    return NextResponse.json({ error: "Invalid routine ID" }, { status: 400 });
  }

  await ensureDB();
  const deleted = await deleteRoutine(id);

  if (!deleted) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
