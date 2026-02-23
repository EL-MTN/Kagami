import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { ImageGenerationRequest, GeneratedImage } from "./types.js";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

interface RefImage {
  filename: string;
  dataUri: string; // "data:image/jpeg;base64,..."
}

const faceRefs: RefImage[] = [];
const bodyRefs: RefImage[] = [];
const outfitMap = new Map<string, RefImage>();
const settingsMap = new Map<string, string>();

function loadDir(dirPath: string): RefImage[] {
  let files: string[];
  try {
    files = fs.readdirSync(dirPath);
  } catch {
    return [];
  }

  const results: RefImage[] = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;

    const data = fs.readFileSync(path.join(dirPath, file));
    const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    const dataUri = `data:${mimeType};base64,${data.toString("base64")}`;

    results.push({ filename: file, dataUri });
    logger.info(
      { file, mimeType, bytes: data.length, dir: path.basename(dirPath) },
      "Loaded reference image",
    );
  }
  return results;
}

function loadSettings() {
  const settingsDir = path.join(config.CONTEXT_PATH, "settings");
  let files: string[];
  try {
    files = fs.readdirSync(settingsDir);
  } catch {
    return;
  }

  for (const file of files) {
    if (path.extname(file).toLowerCase() !== ".md") continue;
    const name = path.basename(file, ".md");
    const content = fs.readFileSync(path.join(settingsDir, file), "utf-8").trim();
    if (content) {
      settingsMap.set(name, content);
    }
  }

  logger.info({ settings: settingsMap.size }, "Loaded settings");
}

export function loadContext() {
  const refDir = path.join(config.CONTEXT_PATH, "references");

  for (const ref of loadDir(path.join(refDir, "face"))) {
    faceRefs.push(ref);
  }
  for (const ref of loadDir(path.join(refDir, "body"))) {
    bodyRefs.push(ref);
  }
  for (const ref of loadDir(path.join(refDir, "outfits"))) {
    outfitMap.set(ref.filename, ref);
  }

  logger.info(
    { face: faceRefs.length, body: bodyRefs.length, outfits: outfitMap.size },
    "Loaded reference images",
  );

  loadSettings();
}

interface OutfitSelection {
  filename: string;
  dataUri: string;
}

async function selectOutfit(sceneDescription: string): Promise<OutfitSelection | null> {
  if (outfitMap.size === 0) return null;

  // Single outfit — no need for LLM
  if (outfitMap.size === 1) {
    const [filename, ref] = [...outfitMap.entries()][0];
    return { filename, dataUri: ref.dataUri };
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
      const firstRef = outfitMap.get(filenames[0])!;
      return { filename: filenames[0], dataUri: firstRef.dataUri };
    }

    logger.info({ selected: original, total: outfitMap.size }, "Selected outfit for scene");
    return { filename: original, dataUri: outfitMap.get(original)!.dataUri };
  } catch (error) {
    logger.warn({ error }, "Outfit selection failed — using first outfit");
    const [filename, ref] = [...outfitMap.entries()][0];
    return { filename, dataUri: ref.dataUri };
  }
}

interface SettingSelection {
  name: string;
  description: string;
}

async function selectSetting(sceneDescription: string): Promise<SettingSelection | null> {
  if (settingsMap.size === 0) return null;

  if (settingsMap.size === 1) {
    const [name, description] = [...settingsMap.entries()][0];
    return { name, description };
  }

  const names = [...settingsMap.keys()];

  try {
    const { text } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      temperature: 0,
      prompt: `You are selecting a location/setting for AI image generation.

Scene to generate: "${sceneDescription}"

Available settings:
${names.join("\n")}

Pick the single most appropriate setting for this scene, or "none" if the scene doesn't match any specific setting.
Return ONLY the setting name, nothing else.`,
    });

    const picked = text.trim().toLowerCase();

    if (picked === "none") return null;

    const nameMap = new Map(names.map((n) => [n.toLowerCase(), n]));
    const original = nameMap.get(picked);

    if (!original) {
      logger.warn(
        { picked, available: names },
        "Setting selection returned unknown name — skipping",
      );
      return null;
    }

    logger.info({ selected: original, total: settingsMap.size }, "Selected setting for scene");
    return { name: original, description: settingsMap.get(original)! };
  } catch (error) {
    logger.warn({ error }, "Setting selection failed — skipping");
    return null;
  }
}

function fileDataUri(filePath: string): string {
  const data = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mimeType};base64,${data.toString("base64")}`;
}

export async function generateImage(request: ImageGenerationRequest): Promise<GeneratedImage> {
  const start = Date.now();

  // Build reference images array (max 3 for xAI)
  const images: { url: string; type: "image_url" }[] = [];
  let outfitInstruction = "";

  if (request.referenceImages) {
    for (const p of request.referenceImages) {
      images.push({ url: fileDataUri(p), type: "image_url" });
    }
  } else {
    // Pick 1 face ref (first available)
    if (faceRefs.length > 0) {
      images.push({ url: faceRefs[0].dataUri, type: "image_url" });
    }
    // Pick 1 body ref (first available)
    if (bodyRefs.length > 0) {
      images.push({ url: bodyRefs[0].dataUri, type: "image_url" });
    }
    // Pick 1 outfit (selected by LLM)
    const outfit = await selectOutfit(request.prompt);
    if (outfit) {
      images.push({ url: outfit.dataUri, type: "image_url" });
      outfitInstruction = `IMPORTANT: She must be wearing the exact outfit shown in the outfit reference image "${outfit.filename}" — match the clothing precisely, ignoring clothing visible in face or body references.`;
    }
  }

  let settingInstruction = "";
  if (!request.referenceImages) {
    const setting = await selectSetting(request.prompt);
    if (setting) {
      settingInstruction = `SETTING DETAILS: The scene takes place in her ${setting.name}. Specific details to include: ${setting.description}`;
    }
  }

  const instructions = [outfitInstruction, settingInstruction].filter(Boolean).join("\n\n");
  const fullPrompt = instructions ? `${request.prompt}\n\n${instructions}` : request.prompt;

  // Choose endpoint based on whether we have reference images
  const hasRefs = images.length > 0;
  const endpoint = hasRefs
    ? "https://api.x.ai/v1/images/edits"
    : "https://api.x.ai/v1/images/generations";

  const body: Record<string, unknown> = {
    model: "grok-imagine-image-pro",
    prompt: fullPrompt,
    response_format: "b64_json",
  };

  if (request.aspectRatio) {
    body.aspect_ratio = request.aspectRatio;
  }

  if (hasRefs) {
    body.images = images;
  }

  logger.info(
    {
      endpoint,
      imageCount: images.length,
      faceRefs: faceRefs.length > 0 ? 1 : 0,
      bodyRefs: bodyRefs.length > 0 ? 1 : 0,
      outfit: outfitInstruction ? true : false,
      setting: settingInstruction ? true : false,
      promptLength: request.prompt.length,
      fullPrompt,
    },
    "Calling xAI image generation",
  );

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.XAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`xAI API error ${response.status}: ${errorText}`);
  }

  const json = (await response.json()) as { data?: { b64_json?: string }[] };
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("No image data in xAI response");
  }

  const buffer = Buffer.from(b64, "base64");
  const mimeType = "image/png";
  const elapsed = Date.now() - start;

  logger.info({ elapsed, mimeType }, "Generated image");

  return { buffer, mimeType };
}
