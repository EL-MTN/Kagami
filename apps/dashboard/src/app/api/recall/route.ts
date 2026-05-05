import { NextResponse } from "next/server";
import { recall } from "@/lib/api";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { query: string; k?: number };
    const result = await recall(body);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
