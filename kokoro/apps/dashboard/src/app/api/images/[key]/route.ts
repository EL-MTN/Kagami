import { NextResponse } from "next/server";
import { readImage } from "@kokoro/db";
import { ensureDB } from "@/lib/db";
import { z } from "zod";

const ImageKey = z.string().uuid();

export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const parsed = ImageKey.safeParse(key);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid image key" }, { status: 400 });
  }

  await ensureDB();

  const result = await readImage(parsed.data);

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
