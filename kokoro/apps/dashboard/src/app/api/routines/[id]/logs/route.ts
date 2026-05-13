import { NextResponse } from "next/server";
import { ensureDB } from "@/lib/db";
import { getRoutineLogList } from "@/lib/queries/routines";
import mongoose from "mongoose";
import { z } from "zod";

const LogQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid routine ID" }, { status: 400 });
  }

  const url = new URL(request.url);
  const parsed = LogQuery.safeParse({ limit: url.searchParams.get("limit") ?? undefined });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid 'limit' query parameter" }, { status: 400 });
  }
  const { limit } = parsed.data;
  const before = url.searchParams.get("before") ?? undefined;

  await ensureDB();
  const result = await getRoutineLogList(id, limit, before);

  return NextResponse.json(result);
}
