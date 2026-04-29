import { NextResponse } from "next/server";
import { Skill, createSkill, isDuplicateKeyError } from "@mashiro/db";
import { computeNextRunAt, validateCronAndDefaults } from "@mashiro/shared";
import { ensureDB } from "@/lib/db";
import { skillCreateSchema, skillExportBundleSchema } from "@/lib/skill-schema";
import { getSkillList } from "@/lib/queries/skills";

export async function GET() {
  await ensureDB();
  const skills = await getSkillList();
  return NextResponse.json({ skills });
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
  const parsed = skillCreateSchema.safeParse(body);

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
    const skill = await createSkill(chatId, {
      ...rest,
      parameters: rest.parameters,
      cronSchedule: cronSchedule ?? null,
      reportMode: rest.reportMode,
      purity: rest.purity,
      nextRunAt,
    });

    return NextResponse.json(
      {
        skill: {
          id: skill._id.toString(),
          chatId: skill.chatId,
          name: skill.name,
          description: skill.description,
          prompt: skill.prompt,
          parameters: skill.parameters,
          cronSchedule: skill.cronSchedule,
          reportMode: skill.reportMode,
          purity: skill.purity,
          enabled: skill.enabled,
          version: skill.version,
          nextRunAt: skill.nextRunAt?.toISOString() ?? null,
          createdAt: skill.createdAt.toISOString(),
          updatedAt: skill.updatedAt.toISOString(),
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return NextResponse.json({ error: "A skill with that name already exists" }, { status: 409 });
    }
    throw error;
  }
}

async function handleImport(request: Request) {
  const body: unknown = await request.json();
  const parsed = skillExportBundleSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid import format", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Determine chatId: use query param or infer from existing skills
  const url = new URL(request.url);
  let chatId = url.searchParams.get("chatId");

  if (!chatId) {
    const existing = await Skill.findOne().lean();
    chatId = existing?.chatId ?? null;
  }

  if (!chatId) {
    return NextResponse.json(
      { error: "No chatId provided and no existing skills to infer from" },
      { status: 400 },
    );
  }

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const item of parsed.data.skills) {
    const cronErr = validateCronAndDefaults(item.cronSchedule, item.parameters);
    if (cronErr) {
      errors.push(`"${item.name}": ${cronErr.message}`);
      continue;
    }
    const nextRunAt = item.cronSchedule ? computeNextRunAt(item.cronSchedule) : null;

    try {
      await createSkill(chatId, {
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
