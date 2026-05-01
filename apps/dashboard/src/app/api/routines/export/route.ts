import { NextResponse } from "next/server";
import { Routine } from "@mashiro/db";
import { ensureDB } from "@/lib/db";
import type { RoutineExportBundle } from "@/lib/routine-schema";
import { serializeParameter } from "@/lib/queries/routines";

export async function GET() {
  await ensureDB();

  const routines = await Routine.find().sort({ createdAt: -1 }).lean();

  const bundle: RoutineExportBundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    count: routines.length,
    routines: routines.map((s) => ({
      name: s.name,
      description: s.description,
      prompt: s.prompt,
      parameters: s.parameters.map(serializeParameter),
      cronSchedule: s.cronSchedule,
      reportMode: s.reportMode,
      purity: s.purity ?? "action",
      enabled: s.enabled,
    })),
  };

  const date = new Date().toISOString().slice(0, 10);

  return new NextResponse(JSON.stringify(bundle, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="routines-export-${date}.json"`,
    },
  });
}
