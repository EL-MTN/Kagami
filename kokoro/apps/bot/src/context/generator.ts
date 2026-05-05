import { generateText, generateImage as aiGenerateImage } from "ai";
import fs from "node:fs/promises";
import path from "node:path";
import { config, logger } from "@kokoro/shared";
import {
  getModel,
  getModelName,
  getImageModel,
  getImageModelSpec,
  ModelTier,
} from "../ai/provider";
import { trackUsage, trackImageGeneration } from "../ai/token-tracker";
import type { ImageGenerationRequest, GeneratedImage } from "./types";

const FAST_LLM_TIMEOUT_MS = 30_000; // 30 seconds for classification calls

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

interface RefImage {
  filename: string;
  dataUri: string; // "data:image/jpeg;base64,..."
}

let faceRefs: RefImage[] = [];
let bodyRefs: RefImage[] = [];
const outfitMap = new Map<string, RefImage>();
const settingsMap = new Map<string, string>();
let imagePrefix = "";

async function loadDir(dirPath: string): Promise<RefImage[]> {
  let files: string[];
  try {
    files = await fs.readdir(dirPath);
  } catch {
    return [];
  }

  const results: RefImage[] = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;

    const data = await fs.readFile(path.join(dirPath, file));
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

async function loadSettings(): Promise<void> {
  settingsMap.clear();

  const settingsDir = path.join(config.CONTEXT_PATH, "settings");
  let files: string[];
  try {
    files = await fs.readdir(settingsDir);
  } catch {
    return;
  }

  for (const file of files) {
    if (path.extname(file).toLowerCase() !== ".md") continue;
    const name = path.basename(file, ".md");
    const content = (await fs.readFile(path.join(settingsDir, file), "utf-8")).trim();
    if (content) {
      settingsMap.set(name, content);
    }
  }

  logger.info({ settings: settingsMap.size }, "Loaded settings");
}

async function loadImagePrefix(): Promise<void> {
  const prefixPath = path.join(config.CONTEXT_PATH, "image-prefix.md");
  try {
    imagePrefix = (await fs.readFile(prefixPath, "utf-8")).trim();
    logger.info({ length: imagePrefix.length }, "Loaded image prefix");
  } catch {
    imagePrefix = "";
  }
}

export async function loadContext(): Promise<void> {
  const refDir = path.join(config.CONTEXT_PATH, "references");

  const [face, body, outfits] = await Promise.all([
    loadDir(path.join(refDir, "face")),
    loadDir(path.join(refDir, "body")),
    loadDir(path.join(refDir, "outfits")),
  ]);

  faceRefs = face;
  bodyRefs = body;
  outfitMap.clear();
  for (const ref of outfits) {
    outfitMap.set(ref.filename, ref);
  }

  logger.info(
    { face: faceRefs.length, body: bodyRefs.length, outfits: outfitMap.size },
    "Loaded reference images",
  );

  await Promise.all([loadSettings(), loadImagePrefix()]);
}

async function selectReference(
  category: string,
  refs: RefImage[],
  sceneDescription: string,
  guidance: string,
): Promise<RefImage | null> {
  if (refs.length === 0) return null;

  const filenames = refs.map((r) => r.filename);

  try {
    const { text, usage } = await generateText({
      model: getModel(ModelTier.Fast),
      temperature: 0,
      abortSignal: AbortSignal.timeout(FAST_LLM_TIMEOUT_MS),
      prompt: `You are selecting a ${category} reference image for AI image generation.

Scene to generate: "${sceneDescription}"

Available ${category} references:
${filenames.join("\n")}

${guidance} Say "none" if none of the references fit the scenario.
Return ONLY the filename or "none", nothing else.`,
    });

    trackUsage("image-selection", getModelName(ModelTier.Fast), usage);

    const picked = text.trim().toLowerCase();

    if (picked === "none") return null;

    const filenameMap = new Map(filenames.map((f) => [f.toLowerCase(), f]));
    const original = filenameMap.get(picked);

    if (!original) {
      logger.warn(
        { category, picked, available: filenames },
        "Reference selection returned unknown filename — skipping",
      );
      return null;
    }

    logger.info({ category, selected: original, total: refs.length }, "Selected reference");
    return refs.find((r) => r.filename === original)!;
  } catch (error) {
    logger.warn({ category, error }, "Reference selection failed — skipping");
    return null;
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
    const { text, usage } = await generateText({
      model: getModel(ModelTier.Fast),
      temperature: 0,
      abortSignal: AbortSignal.timeout(FAST_LLM_TIMEOUT_MS),
      prompt: `You are selecting a location/setting for AI image generation.

Scene to generate: "${sceneDescription}"

Available settings:
${names.join("\n")}

Pick the single most appropriate setting for this scene, or "none" if the scene doesn't match any specific setting.
Return ONLY the setting name, nothing else.`,
    });

    trackUsage("image-selection", getModelName(ModelTier.Fast), usage);

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
    logger.warn({ err: error }, "Setting selection failed — skipping");
    return null;
  }
}

function dataUriToBase64(dataUri: string): string {
  const commaIdx = dataUri.indexOf(",");
  return commaIdx === -1 ? dataUri : dataUri.slice(commaIdx + 1);
}

async function readFileAsBase64(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return data.toString("base64");
}

export async function generateImage(request: ImageGenerationRequest): Promise<GeneratedImage> {
  const { provider, modelId } = getImageModelSpec();
  const start = Date.now();

  // Build reference images as base64 strings for the AI SDK
  const refImages: string[] = [];
  let outfitInstruction = "";

  if (request.referenceImages) {
    for (const p of request.referenceImages) {
      refImages.push(await readFileAsBase64(p));
    }
  } else {
    const [face, body, outfit] = await Promise.all([
      selectReference(
        "face",
        faceRefs,
        request.prompt,
        "Pick the single most appropriate face reference for this scene — consider expression (smiling vs neutral), angle, and mood.",
      ),
      selectReference(
        "body",
        bodyRefs,
        request.prompt,
        "Pick the single most appropriate body reference for this scene — consider pose, framing, and body language.",
      ),
      selectReference(
        "outfit",
        [...outfitMap.values()],
        request.prompt,
        "Pick the single most appropriate outfit for this scene.",
      ),
    ]);

    if (face) {
      refImages.push(dataUriToBase64(face.dataUri));
    }
    if (body) {
      refImages.push(dataUriToBase64(body.dataUri));
    }
    if (outfit) {
      refImages.push(dataUriToBase64(outfit.dataUri));
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

  const fullPrompt = [
    imagePrefix,
    `Scene: ${request.prompt}`,
    outfitInstruction,
    settingInstruction,
  ]
    .filter(Boolean)
    .join("\n\n");

  logger.info(
    {
      provider,
      model: modelId,
      imageCount: refImages.length,
      faceRefs: faceRefs.length,
      bodyRefs: bodyRefs.length,
      outfit: outfitInstruction ? true : false,
      setting: settingInstruction ? true : false,
      promptLength: fullPrompt.length,
      promptPreview: fullPrompt.slice(0, 200),
    },
    "Calling image generation",
  );

  const result = await aiGenerateImage({
    model: getImageModel(),
    prompt: refImages.length > 0 ? { text: fullPrompt, images: refImages } : fullPrompt,
    aspectRatio: request.aspectRatio as `${number}:${number}` | undefined,
  });

  const buffer = Buffer.from(result.image.uint8Array);
  const mimeType = "image/png";
  const elapsed = Date.now() - start;

  trackImageGeneration(modelId, provider);
  logger.info({ elapsed, mimeType, provider, model: modelId }, "Generated image");

  return { buffer, mimeType };
}
