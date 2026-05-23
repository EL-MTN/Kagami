import "dotenv/config";
import { createInference } from "@kagami/llm";
import { embed, embedMany } from "ai";
import { logger } from "./logger.js";

// Canonical config is `{LLM,EMBEDDING}_KIND` (openai-compatible only here) +
// `_BASE_URL` / `_API_KEY` / `LLM_MODEL` / `LLM_TIMEOUT_MS` /
// `EMBEDDING_MODEL`. The pre-gateway keys (`{LLM,EMBEDDING}_PROVIDER` profile
// selector, `_URL`, bare `MODEL`) are still honored for one release with a
// startup deprecation warn — these legacy profiles only fill defaults for
// that fallback path.
const LEGACY_PROFILES = {
  lmstudio: { baseURL: "http://localhost:1234/v1", apiKey: "lm-studio" },
  openai: { baseURL: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY ?? "" },
} as const;
type LegacyProfile = keyof typeof LEGACY_PROFILES;

const deprecated: Record<string, string> = {};

function resolveEndpoint(role: "LLM" | "EMBEDDING"): { baseURL: string; apiKey: string } {
  const apiKey = process.env[`${role}_API_KEY`];
  const canonicalBase = process.env[`${role}_BASE_URL`];
  if (canonicalBase) {
    return { baseURL: canonicalBase, apiKey: apiKey ?? "" };
  }

  // Legacy fallback: profile selector + `_URL`.
  const legacyProvider = process.env[`${role}_PROVIDER`];
  const legacyUrl = process.env[`${role}_URL`];
  if (legacyProvider) deprecated[`${role}_PROVIDER`] = `${role}_KIND + ${role}_BASE_URL`;
  if (legacyUrl) deprecated[`${role}_URL`] = `${role}_BASE_URL`;

  const profileName = (legacyProvider ?? "lmstudio").toLowerCase();
  if (!(profileName in LEGACY_PROFILES)) {
    throw new Error(
      `Unknown ${role}_PROVIDER='${profileName}'. Prefer ${role}_BASE_URL / ${role}_API_KEY; ` +
        `the legacy profile selector accepts only 'lmstudio' | 'openai'.`,
    );
  }
  const profile = LEGACY_PROFILES[profileName as LegacyProfile];
  return { baseURL: legacyUrl ?? profile.baseURL, apiKey: apiKey ?? profile.apiKey };
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

const modelName = process.env.LLM_MODEL ?? process.env.MODEL ?? "";
if (process.env.LLM_MODEL === undefined && process.env.MODEL !== undefined) {
  deprecated.MODEL = "LLM_MODEL";
}
// The default is the local LM Studio embedding model — coherent with the
// `lmstudio` base-URL default in resolveEndpoint, so a no-env checkout is a
// working local-dev setup. The deployed config sets EMBEDDING_MODEL (+ base
// URL / key) to OpenAI `text-embedding-3-small` via .env; see .env.example.
export const embeddingModelName =
  process.env.EMBEDDING_MODEL ?? "text-embedding-nomic-embed-text-v1.5";

if (Object.keys(deprecated).length > 0) {
  logger.warn(
    { deprecated },
    "kioku: legacy LLM/EMBEDDING env keys are deprecated and will be removed next release — " +
      "migrate to the listed canonical keys (old keys still honored this release)",
  );
}
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
// (e.g. indexes.ts) so they report what was actually resolved regardless
// of whether canonical or legacy env keys were used.
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
