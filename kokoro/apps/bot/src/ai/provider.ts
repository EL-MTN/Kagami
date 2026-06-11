import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { xai } from "@ai-sdk/xai";
import { createInference } from "@kagami/llm";
import type { ProviderConfig } from "@kagami/llm";
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
// An openai-compatible endpoint has no per-vendor defaults — every tier
// falls back to LLM_MODEL unless the env overrides name something else.
const tierDefaults =
  config.LLM_KIND === "openai-compatible"
    ? { [ModelTier.Fast]: config.LLM_MODEL, [ModelTier.Smart]: config.LLM_MODEL }
    : (TIER_DEFAULTS[config.LLM_PROVIDER] ?? TIER_DEFAULTS.anthropic);
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
// ModelTier → model-id map above). Native vendors read their provider API
// keys from env exactly as the bare SDK singletons did; openai-compatible
// endpoints (OpenRouter, local servers) take LLM_BASE_URL + LLM_API_KEY.
function chatConfig(): ProviderConfig {
  if (config.LLM_KIND === "openai-compatible") {
    if (!config.LLM_BASE_URL) {
      // validateConfig() enforces this pairing at bot startup; the throw
      // keeps the failure legible if construction ever precedes validation.
      throw new Error('LLM_BASE_URL is required when LLM_KIND is "openai-compatible"');
    }
    return {
      kind: "openai-compatible",
      baseURL: config.LLM_BASE_URL,
      name: config.LLM_PROVIDER_NAME,
      model: config.LLM_MODEL,
      models: tierModels,
      ...(config.LLM_API_KEY ? { apiKey: config.LLM_API_KEY } : {}),
      timeoutMs: config.LLM_ATTEMPT_TIMEOUT_MS,
    };
  }
  return {
    kind: "native",
    vendor: config.LLM_PROVIDER,
    model: config.LLM_MODEL,
    models: tierModels,
    timeoutMs: config.LLM_ATTEMPT_TIMEOUT_MS,
  };
}

const inference = createInference({
  service: "kokoro",
  logger,
  chat: chatConfig(),
});

export function getModel(tier: ModelTier = ModelTier.Default): LanguageModel {
  return tier === ModelTier.Default ? inference.model() : inference.model(tier);
}
