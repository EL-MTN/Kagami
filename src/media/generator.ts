import { GoogleGenAI, type Part } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { MediaAsset } from "../db/models/media-asset.js";
import type { ImageGenerationRequest, GeneratedImage } from "./types.js";

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
const MODEL = "gemini-3-pro-image-preview";

let referenceParts: Part[] = [];

export function loadReferenceImages() {
  const refDir = path.join(config.MEDIA_PATH, "references");

  let files: string[];
  try {
    files = fs.readdirSync(refDir);
  } catch {
    logger.warn("No media/references/ directory found — generating without reference images");
    return;
  }

  const imageFiles = files.filter((f) =>
    [".jpg", ".jpeg", ".png", ".webp"].includes(path.extname(f).toLowerCase()),
  );

  for (const file of imageFiles) {
    const filePath = path.join(refDir, file);
    const data = fs.readFileSync(filePath);
    const ext = path.extname(file).toLowerCase();
    const mimeType =
      ext === ".png" ? "image/png" :
      ext === ".webp" ? "image/webp" :
      "image/jpeg";

    referenceParts.push({
      inlineData: {
        data: data.toString("base64"),
        mimeType,
      },
    });
  }

  logger.info(`Loaded ${referenceParts.length} reference images from ${refDir}`);
}

function hashPrompt(prompt: string): string {
  return crypto.createHash("sha256").update(prompt).digest("hex");
}

export async function generateImage(
  request: ImageGenerationRequest,
): Promise<GeneratedImage> {
  const promptHash = hashPrompt(request.prompt);

  // Check cache first
  const cached = await MediaAsset.findOne({ promptHash });
  if (cached?.imageData) {
    logger.debug({ promptHash }, "Returning cached generated image");
    return {
      buffer: Buffer.from(cached.imageData, "base64"),
      mimeType: cached.mimeType || "image/png",
    };
  }

  const start = Date.now();

  const contents: (string | Part)[] = [];

  // Add reference images for character consistency
  const refs = request.referenceImages
    ? request.referenceImages.map((p) => ({
        inlineData: {
          data: fs.readFileSync(p).toString("base64"),
          mimeType: "image/jpeg" as const,
        },
      }))
    : referenceParts;

  contents.push(...refs);
  contents.push(request.prompt);

  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      responseModalities: ["IMAGE"],
      ...(request.aspectRatio && {
        imageConfig: { aspectRatio: request.aspectRatio },
      }),
    },
  });

  const parts = response.candidates?.[0]?.content?.parts;
  if (!parts) {
    throw new Error("No parts in Gemini image response");
  }

  const imagePart = parts.find((p) => p.inlineData);
  if (!imagePart?.inlineData?.data) {
    throw new Error("No image data in Gemini response");
  }

  const buffer = Buffer.from(imagePart.inlineData.data, "base64");
  const mimeType = imagePart.inlineData.mimeType || "image/png";
  const elapsed = Date.now() - start;

  logger.info({ elapsed, promptHash, mimeType }, "Generated image");

  // Cache in MongoDB
  await MediaAsset.updateOne(
    { promptHash },
    {
      promptHash,
      prompt: request.prompt,
      imageData: imagePart.inlineData.data,
      mimeType,
      generatedAt: new Date(),
    },
    { upsert: true },
  );

  return { buffer, mimeType };
}
