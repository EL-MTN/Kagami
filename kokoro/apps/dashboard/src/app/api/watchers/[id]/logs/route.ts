import { NextResponse } from "next/server";
import { ensureDB } from "@/lib/db";
import { getWatcherLogList } from "@/lib/queries/watchers";
import mongoose from "mongoose";
import { z } from "zod";

const LogQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid watcher ID" }, { status: 400 });
  }

  const url = new URL(request.url);
  const parsed = LogQuery.safeParse({ limit: url.searchParams.get("limit") ?? undefined });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid 'limit' query parameter" }, { status: 400 });
  }
  const { limit } = parsed.data;
  const before = url.searchParams.get("before") ?? undefined;

  if (before !== undefined && Number.isNaN(Date.parse(before))) {
    return NextResponse.json({ error: "Invalid 'before' query parameter" }, { status: 400 });
  }

  await ensureDB();
  const result = await getWatcherLogList(id, limit, before);

  return NextResponse.json(result);
}
