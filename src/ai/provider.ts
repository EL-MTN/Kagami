import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { xai } from "@ai-sdk/xai";
import { config } from "../config.js";
import type { LanguageModelV1 } from "ai";

export enum ModelTier {
  Default = "default",
  Fast = "fast",
  Smart = "smart",
}

const TIER_MODELS: Record<string, Record<ModelTier, string>> = {
  anthropic: {
    [ModelTier.Default]: "",
    [ModelTier.Fast]: "claude-haiku-4-5-20251001",
    [ModelTier.Smart]: "claude-sonnet-4-5",
  },
  openai: {
    [ModelTier.Default]: "",
    [ModelTier.Fast]: "gpt-4o-mini",
    [ModelTier.Smart]: "gpt-4o",
  },
  xai: {
    [ModelTier.Default]: "",
    [ModelTier.Fast]: "grok-4-1-fast-non-reasoning",
    [ModelTier.Smart]: "grok-4",
  },
};

export function getModel(tier: ModelTier = ModelTier.Default): LanguageModelV1 {
  const provider = config.LLM_PROVIDER;
  const modelId = tier === ModelTier.Default ? config.LLM_MODEL : TIER_MODELS[provider][tier];

  if (provider === "anthropic") {
    return anthropic(modelId);
  }
  if (provider === "xai") {
    return xai(modelId);
  }
  return openai(modelId);
}
