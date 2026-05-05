import { NextResponse } from "next/server";
import { Routine, createRoutine, isDuplicateKeyError } from "@kokoro/db";
import { computeNextRunAt, validateCronAndDefaults } from "@kokoro/shared";
import { ensureDB } from "@/lib/db";
import { routineCreateSchema, routineExportBundleSchema } from "@/lib/routine-schema";
import { getRoutineList } from "@/lib/queries/routines";

export async function GET() {
  await ensureDB();
  const routines = await getRoutineList();
  return NextResponse.json({ routines });
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
  const parsed = routineCreateSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { chatId, cronSchedule, ...rest } = parsed.data;

  const cronError = validateCronAndDefaults(cronSchedule, rest.parameters);
  if (cronError) {
    return NextResponse.json({ error: cronError.message }, { status: 400 });
  }
  const nextRunAt = cronSchedule ? computeNextRunAt(cronSchedule) : null;

  try {
    const routine = await createRoutine(chatId, {
      ...rest,
      parameters: rest.parameters,
      cronSchedule: cronSchedule ?? null,
      reportMode: rest.reportMode,
      purity: rest.purity,
      nextRunAt,
    });

    return NextResponse.json(
      {
        routine: {
          id: routine._id.toString(),
          chatId: routine.chatId,
          name: routine.name,
          description: routine.description,
          prompt: routine.prompt,
          parameters: routine.parameters,
          cronSchedule: routine.cronSchedule,
          reportMode: routine.reportMode,
          purity: routine.purity,
          enabled: routine.enabled,
          version: routine.version,
          nextRunAt: routine.nextRunAt?.toISOString() ?? null,
          createdAt: routine.createdAt.toISOString(),
          updatedAt: routine.updatedAt.toISOString(),
        },
      },
      { status: 201 },
    );
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

async function handleImport(request: Request) {
  const body: unknown = await request.json();
  const parsed = routineExportBundleSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid import format", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Determine chatId: use query param or infer from existing routines
  const url = new URL(request.url);
  let chatId = url.searchParams.get("chatId");

  if (!chatId) {
    const existing = await Routine.findOne().lean();
    chatId = existing?.chatId ?? null;
  }

  if (!chatId) {
    return NextResponse.json(
      { error: "No chatId provided and no existing routines to infer from" },
      { status: 400 },
    );
  }

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const item of parsed.data.routines) {
    const cronErr = validateCronAndDefaults(item.cronSchedule, item.parameters);
    if (cronErr) {
      errors.push(`"${item.name}": ${cronErr.message}`);
      continue;
    }
    const nextRunAt = item.cronSchedule ? computeNextRunAt(item.cronSchedule) : null;

    try {
      await createRoutine(chatId, {
        name: item.name,
        description: item.description,
        prompt: item.prompt,
        parameters: item.parameters,
        cronSchedule: item.cronSchedule ?? null,
        reportMode: item.reportMode,
        purity: item.purity,
        nextRunAt,
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
