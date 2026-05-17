import "dotenv/config";
import { createInference } from "@kagami/llm";
import { embed, embedMany } from "ai";
import { logger } from "./logger.js";

// Provider profiles fill in URL + key defaults for common setups. Explicit
// {LLM,EMBEDDING}_URL / _API_KEY env vars always win as overrides.
const PROFILES = {
  lmstudio: { baseURL: "http://localhost:1234/v1", apiKey: "lm-studio" },
  openai: { baseURL: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY ?? "" },
} as const;

type ProviderName = keyof typeof PROFILES;

function resolveEndpoint(role: "LLM" | "EMBEDDING"): { baseURL: string; apiKey: string } {
  const providerName = (process.env[`${role}_PROVIDER`] ?? "lmstudio").toLowerCase();
  if (!(providerName in PROFILES)) {
    throw new Error(`Unknown ${role}_PROVIDER='${providerName}'. Use 'lmstudio' or 'openai'.`);
  }
  const profile = PROFILES[providerName as ProviderName];
  return {
    baseURL: process.env[`${role}_URL`] ?? profile.baseURL,
    apiKey: process.env[`${role}_API_KEY`] ?? profile.apiKey,
  };
}

const llm = resolveEndpoint("LLM");
const emb = resolveEndpoint("EMBEDDING");
const modelName = process.env.MODEL ?? "";
const embeddingModelName = process.env.EMBEDDING_MODEL ?? "text-embedding-nomic-embed-text-v1.5";

if (!modelName) {
  logger.warn("MODEL is unset. Set it in .env to whatever your provider exposes.");
}

// Provider construction, structured-output mode, the LM-Studio
// `reasoning_content` repair (default-on for openai-compatible), retry, and
// span/usage emission now live in @kagami/llm. `supportsStructuredOutputs`
// and `reasoningRepair` keep their gateway defaults — see its SPEC.md §6/§11.
const timeoutMs = process.env.LLM_TIMEOUT_MS
  ? Number.parseInt(process.env.LLM_TIMEOUT_MS, 10)
  : undefined;

const inference = createInference({
  service: "kioku",
  logger,
  chat: {
    kind: "openai-compatible",
    name: "llm",
    baseURL: llm.baseURL,
    apiKey: llm.apiKey,
    model: modelName,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  },
  embedding: {
    kind: "openai-compatible",
    name: "embeddings",
    baseURL: emb.baseURL,
    apiKey: emb.apiKey,
    model: embeddingModelName,
  },
});

// Re-export the resolved chat endpoint for callers like the bench runner
// that build their own LLM instances (e.g. a separate judge model).
export const llmEndpoint = llm;

export const model = inference.model();

export function getEmbeddingModel() {
  return inference.embeddings();
}

// Embedding helpers live in llm.ts (alongside the model factory) to
// avoid a circular import between embeddings.ts and entities.ts.
export async function embedQuestion(q: string): Promise<number[]> {
  const { embedding } = await embed({
    model: getEmbeddingModel(),
    value: q,
    abortSignal: AbortSignal.timeout(5_000),
  });
  return embedding;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { embeddings } = await embedMany({
    model: getEmbeddingModel(),
    values: texts,
    maxParallelCalls: 8,
    abortSignal: AbortSignal.timeout(15_000),
  });
  return embeddings;
}
