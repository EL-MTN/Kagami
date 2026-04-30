import { TokenUsage, type UsageCategory } from "@mashiro/db";
import { config, logger } from "@mashiro/shared";

// Pricing per 1M tokens: [input, output]
const MODEL_PRICING: Record<string, [number, number]> = {
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [0.8, 4],
  "gpt-4o": [2.5, 10],
  "gpt-4o-mini": [0.15, 0.6],
  "grok-4": [3, 15],
  "grok-4-1-fast-non-reasoning": [0.6, 4],
};

// Fixed cost per image generation call (per model)
const IMAGE_GENERATION_PRICING: Record<string, number> = {
  "grok-imagine-image": 0.012,
  "gpt-image-1": 0.04,
  "gpt-image-1-mini": 0.0075,
};

// Cost per 1K characters for TTS
const TTS_GENERATION_PRICING: Record<string, number> = {
  eleven_v3: 0.15,
  eleven_flash_v2_5: 0.15,
  eleven_flash_v2: 0.15,
  eleven_multilingual_v2: 0.15,
  eleven_turbo_v2_5: 0.15,
  "tts-1": 0.015,
  "tts-1-hd": 0.03,
  "gpt-4o-mini-tts": 0.015,
};

// Cost per minute of audio for STT (model-keyed). Local models (whisper.cpp
// via STT_BASE_URL) reuse the model id "whisper-1" but cost $0 — the
// caller can pass an empty/zero entry when the configured STT_BASE_URL is
// non-default. Adjust these as providers update their pricing.
const STT_TRANSCRIPTION_PRICING: Record<string, number> = {
  "whisper-1": 0.006,
  "gpt-4o-transcribe": 0.006,
  "gpt-4o-mini-transcribe": 0.003,
};

interface TokenUsageData {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

function estimateCost(model: string, usage: TokenUsageData): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;

  const [inputPer1M, outputPer1M] = pricing;
  const promptCost = ((usage.promptTokens ?? 0) / 1_000_000) * inputPer1M;
  const completionCost = ((usage.completionTokens ?? 0) / 1_000_000) * outputPer1M;
  return promptCost + completionCost;
}

export interface TrackUsageMetadata {
  chatId?: string;
  sessionId?: string;
  skillId?: string;
  watcherId?: string;
  toolCalls?: number;
  steps?: number;
}

export function trackUsage(
  category: UsageCategory,
  model: string,
  usage: TokenUsageData,
  metadata?: TrackUsageMetadata,
): void {
  const provider = config.LLM_PROVIDER;
  const promptTokens = usage.promptTokens ?? 0;
  const completionTokens = usage.completionTokens ?? 0;
  const totalTokens = usage.totalTokens ?? promptTokens + completionTokens;
  const cost = estimateCost(model, usage);

  logger.info(
    { category, model, promptTokens, completionTokens, totalTokens, estimatedCost: cost },
    "Token usage tracked",
  );

  // Fire-and-forget DB write
  TokenUsage.create({
    timestamp: new Date(),
    category,
    modelName: model,
    provider,
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedCost: cost,
    metadata,
  }).catch((error) => {
    logger.warn({ error }, "Failed to persist token usage");
  });
}

export function trackTtsGeneration(
  model: string,
  provider: string,
  charCount: number,
  metadata?: TrackUsageMetadata,
): void {
  const perThousand = TTS_GENERATION_PRICING[model] ?? 0;
  const cost = (charCount / 1000) * perThousand;

  logger.info(
    { category: "tts-generation", model, provider, charCount, estimatedCost: cost },
    "TTS usage tracked",
  );

  TokenUsage.create({
    timestamp: new Date(),
    category: "tts-generation" as const,
    modelName: model,
    provider,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCost: cost,
    metadata,
  }).catch((error) => {
    logger.warn({ error }, "Failed to persist TTS usage");
  });
}

export function trackSttTranscription(
  model: string,
  provider: string,
  durationSeconds: number | undefined,
  metadata?: TrackUsageMetadata,
): void {
  // Cost is zeroed whenever `STT_BASE_URL` is set, on the assumption the
  // user is pointing at a self-hosted whisper.cpp server (the documented
  // default local setup). If you've pointed `STT_BASE_URL` at a paid
  // hosted whisper-compatible service, this tracker will under-report —
  // check your provider's invoice for ground truth, or add a per-model
  // entry to `STT_TRANSCRIPTION_PRICING` and remove this short-circuit.
  const isCustomEndpoint = !!config.STT_BASE_URL;
  const minutes = durationSeconds !== undefined ? durationSeconds / 60 : 0;
  const perMinute = isCustomEndpoint ? 0 : (STT_TRANSCRIPTION_PRICING[model] ?? 0);
  const cost = minutes * perMinute;

  // Cloud transcription with no duration → silent $0. Warn so operators
  // can spot the precision loss against their actual provider bill. This
  // tends to fire when the STT response shape doesn't include duration
  // (e.g. some local whisper.cpp builds, or future API quirks).
  if (!isCustomEndpoint && durationSeconds === undefined && perMinute > 0) {
    logger.warn(
      { model, provider },
      "STT call returned no duration; cost tracked as $0 (precision loss vs actual bill)",
    );
  }

  logger.info(
    {
      category: "stt-transcription",
      model,
      provider,
      durationSeconds,
      customEndpoint: isCustomEndpoint,
      estimatedCost: cost,
    },
    "STT usage tracked",
  );

  TokenUsage.create({
    timestamp: new Date(),
    category: "stt-transcription" as const,
    modelName: model,
    provider,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCost: cost,
    metadata,
  }).catch((error) => {
    logger.warn({ error }, "Failed to persist STT usage");
  });
}

export function trackImageGeneration(
  model: string,
  provider: string,
  metadata?: TrackUsageMetadata,
): void {
  const cost = IMAGE_GENERATION_PRICING[model] ?? 0;

  logger.info(
    {
      category: "image-generation",
      model,
      provider,
      estimatedCost: cost,
    },
    "Token usage tracked",
  );

  TokenUsage.create({
    timestamp: new Date(),
    category: "image-generation" as const,
    modelName: model,
    provider,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCost: cost,
    metadata,
  }).catch((error) => {
    logger.warn({ error }, "Failed to persist image generation usage");
  });
}
