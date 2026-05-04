import { NextResponse } from "next/server";
import { query } from "@/lib/api";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const result = await query(body);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 502 },
    );
  }
}
