import "dotenv/config";
import { createInference } from "@kagami/llm";
import { embed, embedMany } from "ai";
import { loadEnv } from "./config.js";
import { logger } from "./logger.js";

// Config is `{LLM,EMBEDDING}_KIND` (openai-compatible only — the spec rejects
// anything else at parse) + `_BASE_URL` / `_API_KEY` / `LLM_MODEL` /
// `LLM_TIMEOUT_MS` / `EMBEDDING_MODEL`, declared in env.ts. The deployed
// config points these at OpenAI.
const env = loadEnv();

const llm = { baseURL: env.LLM_BASE_URL ?? "", apiKey: env.LLM_API_KEY ?? "" };
const emb = { baseURL: env.EMBEDDING_BASE_URL ?? "", apiKey: env.EMBEDDING_API_KEY ?? "" };

// LLM_MODEL is canonical; the spec maps the legacy MODEL alias (the
// longmemeval bench's answerer-model variable — see
// apps/api/scripts/longmemeval*.ts) onto it.
const modelName = env.LLM_MODEL ?? "";
export const embeddingModelName = env.EMBEDDING_MODEL;

if (!modelName) {
  logger.warn("LLM_MODEL is unset. Set it in .env to whatever your provider exposes.");
}
// Empty base URLs reach @kagami/llm verbatim and only fail at first request with
// an opaque "Invalid URL" — warn at boot so a no-env checkout fails legibly.
if (!llm.baseURL) {
  logger.warn("LLM_BASE_URL is unset. Set it in .env (e.g. https://api.openai.com/v1).");
}
if (!emb.baseURL) {
  logger.warn("EMBEDDING_BASE_URL is unset. Set it in .env (e.g. https://api.openai.com/v1).");
}

// Provider construction, structured-output mode, the LM-Studio
// `reasoning_content` repair (default-on for openai-compatible), retry, and
// span/usage emission live in @kagami/llm. LLM_TIMEOUT_MS validation
// (positive finite number within Node's timer ceiling, warn + treat-as-unset
// otherwise) lives in the env spec — an out-of-range value would make
// AbortSignal.timeout() throw ERR_OUT_OF_RANGE on every call.
const timeoutMs = env.LLM_TIMEOUT_MS;

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

// Resolved embedding endpoint — single source of truth for diagnostics
// (e.g. indexes.ts) so they report what was actually resolved.
export const embeddingEndpoint = emb;

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
