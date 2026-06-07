import { NextResponse } from "next/server";
import { createSkill, isDuplicateKeyError } from "@kokoro/db";
import { ensureDB } from "@/lib/db";
import { skillCreateSchema } from "@/lib/skill-schema";
import { getSkillList } from "@/lib/queries/skills";

export async function GET() {
  await ensureDB();
  const skills = await getSkillList();
  return NextResponse.json({ skills });
}

export async function POST(request: Request) {
  const body: unknown = await request.json();
  const parsed = skillCreateSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  await ensureDB();

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
