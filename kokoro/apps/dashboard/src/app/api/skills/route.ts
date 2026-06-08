import { NextResponse } from "next/server";
import { Skill, createSkill, isDuplicateKeyError } from "@kokoro/db";
import { ensureDB } from "@/lib/db";
import { skillCreateSchema, skillPackageBundleSchema } from "@/lib/skill-schema";
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

  const { chatId, ...input } = parsed.data;
  try {
    const skill = await createSkill(chatId, input);

    return NextResponse.json(
      {
        skill: {
          id: skill._id.toString(),
          chatId: skill.chatId,
          name: skill.name,
          description: skill.description,
          body: skill.body,
          triggers: skill.triggers,
          tags: skill.tags,
          enabled: skill.enabled,
          source: skill.source,
          linkedRoutineIds: skill.linkedRoutineIds.map((id) => id.toString()),
          version: skill.version,
          lastUsedAt: skill.lastUsedAt?.toISOString() ?? null,
          usageCount: skill.usageCount,
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
  const parsed = skillPackageBundleSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid import format", issues: parsed.error.issues },
      { status: 400 },
    );
  }

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
    try {
      await createSkill(chatId, {
        name: item.name,
        description: item.description,
        body: item.body,
        triggers: item.triggers,
        tags: item.tags,
        enabled: item.enabled,
        source: "imported",
        linkedRoutineIds: [],
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
