import { NextResponse } from "next/server";
import { Watcher } from "@mashiro/db";
import { ensureDB } from "@/lib/db";
import type { WatcherExportBundle } from "@/lib/watcher-schema";

export async function GET() {
  await ensureDB();

  const watchers = await Watcher.find().sort({ createdAt: -1 }).lean();

  const bundle: WatcherExportBundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    count: watchers.length,
    watchers: watchers.map((w) => ({
      name: w.name,
      description: w.description,
      prompt: w.prompt,
      cronSchedule: w.cronSchedule,
      oneShot: w.oneShot ?? false,
      maxFires: w.maxFires ?? null,
      cooldownMs: w.cooldownMs ?? null,
      expiresAt: w.expiresAt?.toISOString() ?? null,
      enabled: w.enabled,
    })),
  };

  const date = new Date().toISOString().slice(0, 10);

  return new NextResponse(JSON.stringify(bundle, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="watchers-export-${date}.json"`,
    },
  });
}
