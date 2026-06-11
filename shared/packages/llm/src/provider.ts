import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { wrapLanguageModel } from "ai";
import type { EmbeddingModelV3, LanguageModelV3 } from "@ai-sdk/provider";
import { hoistSystemMessagesMiddleware, reasoningRepairMiddleware } from "./middleware.js";
import type {
  NativeProviderConfig,
  OpenAICompatibleProviderConfig,
  ProviderConfig,
} from "./types.js";

/**
 * Resolve a model id for a provider given an optional alias and the workspace
 * shared alias map. Returns `undefined` when an alias was requested but this
 * provider cannot serve it — the caller decides whether that is fatal (primary)
 * or a skip (fallback). With no alias, the provider's default model is used.
 */
export function resolveModelId(
  cfg: ProviderConfig,
  alias: string | undefined,
  shared: Record<string, string> | undefined,
): string | undefined {
  if (alias === undefined) return cfg.model;
  return cfg.models?.[alias] ?? shared?.[alias];
}

/** Stable provider label for logs/spans. */
export function providerLabel(cfg: ProviderConfig): string {
  return cfg.kind === "native" ? cfg.vendor : (cfg.name ?? "openai-compatible");
}

const NATIVE_FACTORIES = {
  anthropic: createAnthropic,
  openai: createOpenAI,
  xai: createXai,
  google: createGoogleGenerativeAI,
} as const;

function buildNative(cfg: NativeProviderConfig, modelId: string): LanguageModelV3 {
  const settings: { apiKey?: string; baseURL?: string } = {};
  if (cfg.apiKey !== undefined) settings.apiKey = cfg.apiKey;
  if (cfg.baseURL !== undefined) settings.baseURL = cfg.baseURL;
  const provider = NATIVE_FACTORIES[cfg.vendor](settings);
  const model = provider(modelId);
  // Anthropic rejects system messages that follow user/assistant turns.
  if (cfg.vendor === "anthropic") {
    return wrapLanguageModel({ model, middleware: hoistSystemMessagesMiddleware });
  }
  return model;
}

function openAICompatibleProvider(cfg: OpenAICompatibleProviderConfig) {
  const settings: {
    name: string;
    baseURL: string;
    apiKey?: string;
    supportsStructuredOutputs?: boolean;
  } = {
    name: cfg.name ?? "openai-compatible",
    baseURL: cfg.baseURL,
    // LM Studio rejects `json_object`; default to json_schema mode.
    supportsStructuredOutputs: cfg.supportsStructuredOutputs ?? true,
  };
  if (cfg.apiKey !== undefined) settings.apiKey = cfg.apiKey;
  return createOpenAICompatible(settings);
}

function buildOpenAICompatible(
  cfg: OpenAICompatibleProviderConfig,
  modelId: string,
): LanguageModelV3 {
  const model = openAICompatibleProvider(cfg)(modelId);
  // Default-on for this kind; opt out only for an endpoint
  // that uses `reasoning_content` semantically.
  if (cfg.reasoningRepair === false) return model;
  return wrapLanguageModel({ model, middleware: reasoningRepairMiddleware });
}

/** Construct a single concrete model for `cfg` at `modelId` (no retry/fallback). */
export function buildLeaf(cfg: ProviderConfig, modelId: string): LanguageModelV3 {
  return cfg.kind === "native" ? buildNative(cfg, modelId) : buildOpenAICompatible(cfg, modelId);
}

/** Text embedding model from an openai-compatible provider. */
export function buildEmbedding(cfg: OpenAICompatibleProviderConfig): EmbeddingModelV3 {
  return openAICompatibleProvider(cfg).textEmbeddingModel(cfg.model);
}
