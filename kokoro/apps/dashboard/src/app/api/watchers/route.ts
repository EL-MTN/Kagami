import { NextResponse } from "next/server";
import { Watcher, createWatcher, defaultExpiresAt, isDuplicateKeyError } from "@kokoro/db";
import { computeNextRunAt, validateCronAndDefaults } from "@kokoro/shared";
import { ensureDB } from "@/lib/db";
import { watcherCreateSchema, watcherExportBundleSchema } from "@/lib/watcher-schema";
import { getWatcherList } from "@/lib/queries/watchers";

export async function GET() {
  await ensureDB();
  const watchers = await getWatcherList();
  return NextResponse.json({ watchers });
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  await ensureDB();

  if (action === "import") {
    return handleImport(request);
  }

  return handleCreate(request);
}

async function handleCreate(request: Request) {
  const body: unknown = await request.json();
  const parsed = watcherCreateSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { chatId, cronSchedule, expiresAt, oneShot, maxFires, cooldownMs, ...rest } = parsed.data;

  const cronError = validateCronAndDefaults(cronSchedule, []);
  if (cronError) {
    return NextResponse.json({ error: cronError.message }, { status: 400 });
  }
  const nextRunAt = computeNextRunAt(cronSchedule);

  try {
    const watcher = await createWatcher(chatId, {
      ...rest,
      cronSchedule,
      nextRunAt,
      expiresAt: expiresAt ? new Date(expiresAt) : defaultExpiresAt(),
      oneShot,
      maxFires,
      cooldownMs,
    });

    return NextResponse.json(
      {
        watcher: {
          id: watcher._id.toString(),
          chatId: watcher.chatId,
          name: watcher.name,
          description: watcher.description,
          prompt: watcher.prompt,
          cronSchedule: watcher.cronSchedule,
          enabled: watcher.enabled,
          version: watcher.version,
          fireCount: watcher.fireCount,
          lastFiredAt: watcher.lastFiredAt?.toISOString() ?? null,
          nextRunAt: watcher.nextRunAt?.toISOString() ?? null,
          expiresAt: watcher.expiresAt?.toISOString() ?? null,
          archivedAt: watcher.archivedAt?.toISOString() ?? null,
          oneShot: watcher.oneShot,
          maxFires: watcher.maxFires,
          cooldownMs: watcher.cooldownMs,
          snoozedUntil: watcher.snoozedUntil?.toISOString() ?? null,
          createdAt: watcher.createdAt.toISOString(),
          updatedAt: watcher.updatedAt.toISOString(),
        },
      },
      { status: 201 },
    );
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

async function handleImport(request: Request) {
  const body: unknown = await request.json();
  const parsed = watcherExportBundleSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid import format", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  let chatId = url.searchParams.get("chatId");

  if (!chatId) {
    const existing = await Watcher.findOne().lean();
    chatId = existing?.chatId ?? null;
  }

  if (!chatId) {
    return NextResponse.json(
      { error: "No chatId provided and no existing watchers to infer from" },
      { status: 400 },
    );
  }

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const item of parsed.data.watchers) {
    const cronErr = validateCronAndDefaults(item.cronSchedule, []);
    if (cronErr) {
      errors.push(`"${item.name}": ${cronErr.message}`);
      continue;
    }
    const nextRunAt = computeNextRunAt(item.cronSchedule);

    try {
      await createWatcher(chatId, {
        name: item.name,
        description: item.description,
        prompt: item.prompt,
        cronSchedule: item.cronSchedule,
        nextRunAt,
        expiresAt: item.expiresAt ? new Date(item.expiresAt) : defaultExpiresAt(),
        oneShot: item.oneShot,
        maxFires: item.maxFires,
        cooldownMs: item.cooldownMs,
        enabled: item.enabled,
      });
      imported++;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        skipped++;
      } else {
        errors.push(`"${item.name}": ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
  }

  return NextResponse.json({ imported, skipped, errors });
}
