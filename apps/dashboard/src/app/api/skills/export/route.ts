import { NextResponse } from "next/server";
import { Skill } from "@mashiro/db";
import { ensureDB } from "@/lib/db";
import type { SkillExportBundle } from "@/lib/skill-schema";
import { serializeParameter } from "@/lib/queries/skills";

export async function GET() {
  await ensureDB();

  const skills = await Skill.find().sort({ createdAt: -1 }).lean();

  const bundle: SkillExportBundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    count: skills.length,
    skills: skills.map((s) => ({
      name: s.name,
      description: s.description,
      prompt: s.prompt,
      parameters: s.parameters.map(serializeParameter),
      cronSchedule: s.cronSchedule,
      reportMode: s.reportMode,
      enabled: s.enabled,
    })),
  };

  const date = new Date().toISOString().slice(0, 10);

  return new NextResponse(JSON.stringify(bundle, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="skills-export-${date}.json"`,
    },
  });
}
