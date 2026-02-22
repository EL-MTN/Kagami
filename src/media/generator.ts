import { GoogleGenAI, type Part } from "@google/genai";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { MediaAsset } from "../db/models/media-asset.js";
import type { ImageGenerationRequest, GeneratedImage } from "./types.js";

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
const MODEL = "gemini-3-pro-image-preview";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const faceRefs: Part[] = [];
const bodyRefs: Part[] = [];
const outfitMap = new Map<string, Part>();

function loadDir(dirPath: string): { filename: string; part: Part }[] {
  let files: string[];
  try {
    files = fs.readdirSync(dirPath);
  } catch {
    return [];
  }

  const results: { filename: string; part: Part }[] = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;

    const data = fs.readFileSync(path.join(dirPath, file));
    const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    const part: Part = { inlineData: { data: data.toString("base64"), mimeType } };

    results.push({ filename: file, part });
    logger.info(
      { file, mimeType, bytes: data.length, dir: path.basename(dirPath) },
      "Loaded reference image",
    );
  }
  return results;
}

export function loadReferenceImages() {
  const refDir = path.join(config.MEDIA_PATH, "references");

  for (const { part } of loadDir(path.join(refDir, "face"))) {
    faceRefs.push(part);
  }
  for (const { part } of loadDir(path.join(refDir, "body"))) {
    bodyRefs.push(part);
  }
  for (const { filename, part } of loadDir(path.join(refDir, "outfits"))) {
    outfitMap.set(filename, part);
  }

  logger.info(
    { face: faceRefs.length, body: bodyRefs.length, outfits: outfitMap.size },
    "Loaded reference images",
  );
}

function hashPrompt(prompt: string): string {
  return crypto.createHash("sha256").update(prompt).digest("hex");
}

interface OutfitSelection {
  filename: string;
  part: Part;
}

async function selectOutfit(sceneDescription: string): Promise<OutfitSelection | null> {
  if (outfitMap.size === 0) return null;

  // Single outfit — no need for LLM
  if (outfitMap.size === 1) {
    const [filename, part] = [...outfitMap.entries()][0];
    return { filename, part };
  }

  const filenames = [...outfitMap.keys()];

  try {
    const { text } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      temperature: 0,
      prompt: `You are selecting an outfit reference image for AI image generation.

Scene to generate: "${sceneDescription}"

Available outfits:
${filenames.join("\n")}

Pick the single most appropriate outfit for this scene.
Return ONLY the filename, nothing else.`,
    });

    const picked = text.trim();
    const filenameMap = new Map(filenames.map((f) => [f.toLowerCase(), f]));
    const original = filenameMap.get(picked.toLowerCase());

    if (!original) {
      logger.warn(
        { picked, available: filenames },
        "Outfit selection returned unknown filename — using first outfit",
      );
      return { filename: filenames[0], part: outfitMap.get(filenames[0])! };
    }

    logger.info({ selected: original, total: outfitMap.size }, "Selected outfit for scene");
    return { filename: original, part: outfitMap.get(original)! };
  } catch (error) {
    logger.warn({ error }, "Outfit selection failed — using first outfit");
    const [filename, part] = [...outfitMap.entries()][0];
    return { filename, part };
  }
}

export async function generateImage(request: ImageGenerationRequest): Promise<GeneratedImage> {
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

  // Add reference images grouped by role
  let outfitInstruction = "";
  if (request.referenceImages) {
    for (const p of request.referenceImages) {
      const filename = path.basename(p);
      contents.push(`Reference image (${filename}):`);
      contents.push({
        inlineData: {
          data: fs.readFileSync(p).toString("base64"),
          mimeType: "image/jpeg" as const,
        },
      });
    }
  } else {
    for (const part of faceRefs) {
      contents.push("Face/identity reference:");
      contents.push(part);
    }
    for (const part of bodyRefs) {
      contents.push("Body/pose reference:");
      contents.push(part);
    }

    const outfit = await selectOutfit(request.prompt);
    if (outfit) {
      contents.push(`Outfit reference — match this clothing exactly (${outfit.filename}):`);
      contents.push(outfit.part);
      outfitInstruction = `IMPORTANT: She must be wearing the exact outfit shown in the outfit reference image "${outfit.filename}" — match the clothing precisely, ignoring clothing visible in face or body references.`;
    }
  }

  contents.push(outfitInstruction ? `${request.prompt}\n\n${outfitInstruction}` : request.prompt);

  const refCount = contents.filter((c) => typeof c !== "string").length;
  logger.info(
    { referenceCount: refCount, promptLength: request.prompt.length },
    "Calling Gemini image generation",
  );

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
