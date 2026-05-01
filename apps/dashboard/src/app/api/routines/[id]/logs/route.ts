import { NextResponse } from "next/server";
import { ensureDB } from "@/lib/db";
import { getRoutineLogList } from "@/lib/queries/routines";
import mongoose from "mongoose";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid routine ID" }, { status: 400 });
  }

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const before = url.searchParams.get("before") ?? undefined;

  await ensureDB();
  const result = await getRoutineLogList(id, limit, before);

  return NextResponse.json(result);
}
