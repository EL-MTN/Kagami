import { NextResponse } from "next/server";
import { Skill, createSkill, isDuplicateKeyError } from "@kokoro/db";
import { ensureDB } from "@/lib/db";
import {
  inferLegacySkillPackageChatId,
  resolveSkillPackageImportChatId,
} from "@/lib/skill-package";
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
  const requestedChatId = url.searchParams.get("chatId") || null;
  const needsFallbackChatId = !requestedChatId && parsed.data.skills.some((item) => !item.chatId);
  let fallbackChatId = requestedChatId;

  if (needsFallbackChatId) {
    const existingChatIds = await Skill.distinct("chatId");
    fallbackChatId = inferLegacySkillPackageChatId(existingChatIds);
  }

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const item of parsed.data.skills) {
    const targetChatId = resolveSkillPackageImportChatId({
      requestedChatId,
      itemChatId: item.chatId,
      fallbackChatId,
    });

    if (!targetChatId) {
      errors.push(`"${item.name}": missing chatId`);
      continue;
    }

    try {
      await createSkill(targetChatId, {
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
