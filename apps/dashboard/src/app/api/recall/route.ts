import { NextResponse } from "next/server";
import { recall } from "@/lib/api";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const result = await recall(body);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
