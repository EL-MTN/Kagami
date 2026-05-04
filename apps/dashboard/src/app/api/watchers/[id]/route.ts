import { NextResponse } from "next/server";
import { getWatcherById, updateWatcher, deleteWatcher, isDuplicateKeyError } from "@kokoro/db";
import { computeNextRunAt, validateCronAndDefaults } from "@kokoro/shared";
import { ensureDB } from "@/lib/db";
import { getWatcherDetail } from "@/lib/queries/watchers";
import { watcherPatchSchema } from "@/lib/watcher-schema";
import mongoose from "mongoose";

type RouteParams = { params: Promise<{ id: string }> };

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

export async function GET(_request: Request, { params }: RouteParams) {
  const { id } = await params;
  if (!isValidObjectId(id)) {
    return NextResponse.json({ error: "Invalid watcher ID" }, { status: 400 });
  }

  await ensureDB();
  const watcher = await getWatcherDetail(id);

  if (!watcher) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ watcher });
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { id } = await params;
  if (!isValidObjectId(id)) {
    return NextResponse.json({ error: "Invalid watcher ID" }, { status: 400 });
  }

  const body: unknown = await request.json();
  const parsed = watcherPatchSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  await ensureDB();

  const existing = await getWatcherById(id);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const patch: Record<string, unknown> = {};
  const data = parsed.data;

  if (data.name !== undefined) patch.name = data.name;
  if (data.description !== undefined) patch.description = data.description;
  if (data.prompt !== undefined) patch.prompt = data.prompt;
  if (data.enabled !== undefined) patch.enabled = data.enabled;
  if (data.oneShot !== undefined) patch.oneShot = data.oneShot;
  if (data.maxFires !== undefined) patch.maxFires = data.maxFires;
  if (data.cooldownMs !== undefined) patch.cooldownMs = data.cooldownMs;
  if (data.snoozedUntil !== undefined) {
    patch.snoozedUntil = data.snoozedUntil ? new Date(data.snoozedUntil) : null;
  }
  if (data.expiresAt !== undefined) {
    patch.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
  }

  if (data.cronSchedule !== undefined) {
    const cronErr = validateCronAndDefaults(data.cronSchedule, []);
    if (cronErr) {
      return NextResponse.json({ error: cronErr.message }, { status: 400 });
    }
    patch.cronSchedule = data.cronSchedule;
    patch.nextRunAt = computeNextRunAt(data.cronSchedule);
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No fields supplied to update" }, { status: 400 });
  }

  patch.version = existing.version + 1;

  try {
    const updated = await updateWatcher(id, patch);
    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const detail = await getWatcherDetail(id);
    return NextResponse.json({ watcher: detail });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return NextResponse.json(
        { error: "A watcher with that name already exists" },
        { status: 409 },
      );
    }
    throw error;
  }
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const { id } = await params;
  if (!isValidObjectId(id)) {
    return NextResponse.json({ error: "Invalid watcher ID" }, { status: 400 });
  }

  await ensureDB();
  const deleted = await deleteWatcher(id);

  if (!deleted) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
