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

// Fixed cost per xAI image generation call
const IMAGE_GENERATION_COST = 0.012;

interface TokenUsageData {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export function estimateCost(model: string, usage: TokenUsageData): number {
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
  workflowId?: string;
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

export function trackImageGeneration(metadata?: TrackUsageMetadata): void {
  logger.info(
    {
      category: "image-generation",
      model: "grok-imagine-image",
      estimatedCost: IMAGE_GENERATION_COST,
    },
    "Token usage tracked",
  );

  TokenUsage.create({
    timestamp: new Date(),
    category: "image-generation" as const,
    modelName: "grok-imagine-image",
    provider: "xai",
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCost: IMAGE_GENERATION_COST,
    metadata,
  }).catch((error) => {
    logger.warn({ error }, "Failed to persist image generation usage");
  });
}
