import "dotenv/config";
import { createInference } from "@kagami/llm";
import { embed, embedMany } from "ai";
import { logger } from "./logger.js";

// Config is `{LLM,EMBEDDING}_KIND` (openai-compatible only here) + `_BASE_URL` /
// `_API_KEY` / `LLM_MODEL` / `LLM_TIMEOUT_MS` / `EMBEDDING_MODEL`. See
// .env.example; the deployed config points these at OpenAI.
function resolveEndpoint(role: "LLM" | "EMBEDDING"): { baseURL: string; apiKey: string } {
  return {
    baseURL: process.env[`${role}_BASE_URL`] ?? "",
    apiKey: process.env[`${role}_API_KEY`] ?? "",
  };
}

// Kioku is openai-compatible only — reject a mis-set *_KIND loudly rather
// than silently ignoring it.
for (const role of ["LLM", "EMBEDDING"] as const) {
  const kind = process.env[`${role}_KIND`];
  if (kind && kind !== "openai-compatible") {
    throw new Error(`${role}_KIND='${kind}' is unsupported in Kioku — only 'openai-compatible'.`);
  }
}

const llm = resolveEndpoint("LLM");
const emb = resolveEndpoint("EMBEDDING");

const modelName = process.env.LLM_MODEL ?? "";
// Embedding model; override via EMBEDDING_MODEL in .env. The deployed config
// sets it (+ base URL / key) to OpenAI `text-embedding-3-small`; see
// .env.example.
export const embeddingModelName = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";

if (!modelName) {
  logger.warn("LLM_MODEL is unset. Set it in .env to whatever your provider exposes.");
}

// Provider construction, structured-output mode, the LM-Studio
// `reasoning_content` repair (default-on for openai-compatible), retry, and
// span/usage emission live in @kagami/llm.
// `Number()` not `parseInt`: parseInt partial-parses ("180s" -> 180,
// "1e5" -> 1), silently yielding a wrong timeout. `Number()` rejects
// suffixed junk as NaN ("180s" -> NaN) and parses scientific notation
// correctly ("1e5" -> 100000). A value must be a positive finite number
// within Node's timer ceiling; anything else is treated as "unset" (no
// gateway timeout) with a warn — an out-of-range value would otherwise
// make AbortSignal.timeout() throw ERR_OUT_OF_RANGE (or int32-overflow
// to an instant abort) on every call.
const MAX_TIMEOUT_MS = 2_147_483_647; // Node setTimeout / AbortSignal.timeout ceiling
const rawTimeout = process.env.LLM_TIMEOUT_MS;
const parsedTimeout = rawTimeout ? Number(rawTimeout) : undefined;
const timeoutMs =
  parsedTimeout !== undefined &&
  Number.isFinite(parsedTimeout) &&
  parsedTimeout > 0 &&
  parsedTimeout <= MAX_TIMEOUT_MS
    ? parsedTimeout
    : undefined;
if (rawTimeout && timeoutMs === undefined) {
  logger.warn(`LLM_TIMEOUT_MS="${rawTimeout}" is not a positive number within range — ignoring.`);
}

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
