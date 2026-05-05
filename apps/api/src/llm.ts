import 'dotenv/config';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { wrapLanguageModel } from 'ai';
import type { LanguageModelV3Middleware } from '@ai-sdk/provider';

// Provider profiles fill in URL + key defaults for common setups. Explicit
// {LLM,EMBEDDING}_URL / _API_KEY env vars always win as overrides.
const PROFILES = {
  lmstudio: { baseURL: 'http://localhost:1234/v1', apiKey: 'lm-studio' },
  openai: { baseURL: 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY ?? '' },
} as const;

type ProviderName = keyof typeof PROFILES;

function resolveEndpoint(role: 'LLM' | 'EMBEDDING'): { baseURL: string; apiKey: string } {
  const providerName = (process.env[`${role}_PROVIDER`] ?? 'lmstudio').toLowerCase();
  if (!(providerName in PROFILES)) {
    throw new Error(
      `Unknown ${role}_PROVIDER='${providerName}'. Use 'lmstudio' or 'openai'.`,
    );
  }
  const profile = PROFILES[providerName as ProviderName];
  return {
    baseURL: process.env[`${role}_URL`] ?? profile.baseURL,
    apiKey: process.env[`${role}_API_KEY`] ?? profile.apiKey,
  };
}

const llm = resolveEndpoint('LLM');
const emb = resolveEndpoint('EMBEDDING');
const modelName = process.env.MODEL ?? '';

if (!modelName) {
  console.warn(
    '[kioku] MODEL is unset. Set it in .env to whatever your provider exposes.',
  );
}

// `supportsStructuredOutputs: true` makes the provider send
// `response_format: { type: "json_schema", ... }` instead of the default
// `json_object`, which LM Studio rejects with "must be 'json_schema' or 'text'".
// The option is honored at runtime but isn't in the public settings type.
const provider = createOpenAICompatible({
  name: 'llm',
  baseURL: llm.baseURL,
  apiKey: llm.apiKey,
  supportsStructuredOutputs: true,
} as Parameters<typeof createOpenAICompatible>[0]);

// Embeddings can target a different endpoint than chat — e.g. chat=OpenAI
// gpt-4o-mini while embeddings run through a local LM Studio nomic model.
// Reuses the chat provider when both endpoints resolve to the same place.
const embeddingProvider =
  emb.baseURL === llm.baseURL && emb.apiKey === llm.apiKey
    ? provider
    : createOpenAICompatible({
        name: 'embeddings',
        baseURL: emb.baseURL,
        apiKey: emb.apiKey,
      });

// Re-export the resolved chat endpoint for callers like the bench runner
// that build their own LLM instances (e.g. a separate judge model).
export const llmEndpoint = llm;

// Thinking-mode models (GLM-4.7-flash, Qwen3.6, etc.) sometimes emit their
// final structured output into the `reasoning_content` field while leaving
// the assistant `content` empty. The AI SDK reads only the text-typed
// content parts, so generateObject sees nothing and throws
// AI_NoObjectGeneratedError. This middleware repairs that case: when the
// generate result has no non-empty text part but does have one or more
// reasoning parts, promote the concatenated reasoning text to a text part.
//
// Tool-call results are untouched — when the model emits a tool_call
// alongside reasoning, the tool_call part survives unchanged.
const reasoningToContentMiddleware: LanguageModelV3Middleware = {
  specificationVersion: 'v3',
  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();
    const hasText = result.content.some(
      (p) => p.type === 'text' && p.text.trim().length > 0,
    );
    if (hasText) return result;
    const reasoning = result.content
      .filter((p): p is { type: 'reasoning'; text: string } => p.type === 'reasoning')
      .map((p) => p.text)
      .join('');
    if (reasoning.trim().length === 0) return result;
    return {
      ...result,
      content: [
        ...result.content.filter((p) => p.type !== 'text' && p.type !== 'reasoning'),
        { type: 'text', text: reasoning },
      ],
    };
  },
};

export const model = wrapLanguageModel({
  model: provider(modelName),
  middleware: reasoningToContentMiddleware,
});

export function getEmbeddingModel() {
  const name =
    process.env.EMBEDDING_MODEL ?? 'text-embedding-nomic-embed-text-v1.5';
  return embeddingProvider.textEmbeddingModel(name);
}

// Embedding helpers live in llm.ts (alongside the model factory) to
// avoid a circular import between embeddings.ts and entities.ts.
import { embed, embedMany } from 'ai';

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

