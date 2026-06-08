import { NextResponse } from "next/server";
import { Skill } from "@kokoro/db";
import { ensureDB } from "@/lib/db";
import { createSkillPackageBundle } from "@/lib/skill-package";

export async function GET(request: Request) {
  await ensureDB();

  const url = new URL(request.url);
  const chatId = url.searchParams.get("chatId");
  const filter = chatId ? { chatId } : {};
  const skills = await Skill.find(filter).sort({ createdAt: -1 }).lean();
  const bundle = createSkillPackageBundle(skills);

  const date = new Date().toISOString().slice(0, 10);

  return new NextResponse(JSON.stringify(bundle, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="skills-export-${date}.json"`,
    },
  });
}
