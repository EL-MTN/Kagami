import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { xai } from "@ai-sdk/xai";
import { createInference } from "@kagami/llm";
import { config, logger } from "@kokoro/shared";
import type { LanguageModel } from "ai";

export enum ModelTier {
  Default = "default",
  Fast = "fast",
  Smart = "smart",
}

type NonDefaultTier = Exclude<ModelTier, ModelTier.Default>;

const TIER_DEFAULTS: Record<string, Record<NonDefaultTier, string>> = {
  anthropic: {
    [ModelTier.Fast]: "claude-haiku-4-5",
    [ModelTier.Smart]: "claude-sonnet-4-6",
  },
  openai: {
    [ModelTier.Fast]: "gpt-4o-mini",
    [ModelTier.Smart]: "gpt-4o",
  },
  xai: {
    [ModelTier.Fast]: "grok-4-1-fast-non-reasoning",
    [ModelTier.Smart]: "grok-4",
  },
};

// Resolved tier → model-id map: env overrides (LLM_MODEL_{FAST,SMART}) win,
// else the per-provider defaults above. Computed once; behavior is identical
// to the old hardcoded map when the overrides are unset.
// `?? .anthropic` defends partial config mocks in tests where
// `config.LLM_PROVIDER` is absent; for a real (Zod-validated) config the
// provider is always a TIER_DEFAULTS key, so this is a no-op there.
const tierDefaults = TIER_DEFAULTS[config.LLM_PROVIDER] ?? TIER_DEFAULTS.anthropic;
const tierModels: Record<NonDefaultTier, string> = {
  [ModelTier.Fast]: config.LLM_MODEL_FAST ?? tierDefaults[ModelTier.Fast],
  [ModelTier.Smart]: config.LLM_MODEL_SMART ?? tierDefaults[ModelTier.Smart],
};

export function getModelName(tier: ModelTier = ModelTier.Default): string {
  return tier === ModelTier.Default ? config.LLM_MODEL : tierModels[tier];
}

// --- Image model (provider/model compound format) ---

function parseModelSpec(spec: string): { provider: string; modelId: string } {
  const slash = spec.indexOf("/");
  if (slash === -1) throw new Error(`Invalid model spec "${spec}" — expected "provider/model"`);
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

const imageModelFactories: Record<string, (id: string) => ReturnType<typeof xai.image>> = {
  xai: (id) => xai.image(id),
  openai: (id) => openai.image(id),
  google: (id) => google.image(id),
};

export function getImageModel() {
  const spec = config.IMAGE_GENERATION_MODEL;
  if (!spec) throw new Error("IMAGE_GENERATION_MODEL is not configured");
  const { provider, modelId } = parseModelSpec(spec);
  const factory = imageModelFactories[provider];
  if (!factory) throw new Error(`Unsupported image provider "${provider}"`);
  return factory(modelId);
}

export function getImageModelSpec(): { provider: string; modelId: string } {
  const spec = config.IMAGE_GENERATION_MODEL;
  if (!spec) throw new Error("IMAGE_GENERATION_MODEL is not configured");
  return parseModelSpec(spec);
}

// --- Language model ---

// Provider/key construction, retry, and span+usage emission now live in
// @kagami/llm. This module stays the caller-side tier *policy* (the
// ModelTier → model-id map above) — see @kagami/llm SPEC.md §8. Native
// vendor reads provider API keys from env exactly as the bare SDK
// singletons did, so behavior is unchanged.
const inference = createInference({
  service: "kokoro",
  logger,
  chat: {
    kind: config.LLM_KIND,
    vendor: config.LLM_PROVIDER,
    model: config.LLM_MODEL,
    models: tierModels,
  },
});

export function getModel(tier: ModelTier = ModelTier.Default): LanguageModel {
  return tier === ModelTier.Default ? inference.model() : inference.model(tier);
}
