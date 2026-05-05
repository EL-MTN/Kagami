import { NextResponse } from "next/server";
import { readImage } from "@kokoro/db";
import { ensureDB } from "@/lib/db";

export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  await ensureDB();

  const result = await readImage(key);

  if (!result) {
    return new NextResponse("Not found", { status: 404 });
  }

  return new NextResponse(new Uint8Array(result.data), {
    headers: {
      "Content-Type": result.mimeType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
