import type { LanguageModelV3CallOptions, LanguageModelV3Middleware } from "@ai-sdk/provider";

/**
 * Per-attempt deadline. Merges a fresh `AbortSignal.timeout(ms)` into the
 * call's existing signal so the caller's own cancellation still wins; the
 * attempt loop in fallback.ts re-invokes the wrapped leaf, so the budget
 * resets per attempt.
 */
export function timeoutMiddleware(ms: number): LanguageModelV3Middleware {
  return {
    specificationVersion: "v3",
    transformParams: ({ params }: { params: LanguageModelV3CallOptions }) => {
      const deadline = AbortSignal.timeout(ms);
      const signal = params.abortSignal
        ? AbortSignal.any([params.abortSignal, deadline])
        : deadline;
      return Promise.resolve({ ...params, abortSignal: signal });
    },
  };
}

/**
 * Anthropic accepts system messages only as a leading block (they become the
 * top-level `system` param); one appearing after a user/assistant turn makes
 * the message converter throw `AI_UnsupportedFunctionalityError`. Callers
 * legitimately trail system messages — Kokoro appends minute-precision time
 * after the history so the cacheable prefix stays stable on OpenAI-shaped
 * providers — so hoist displaced system messages into the leading block
 * instead of failing the call. No-op when the prompt is already conformant.
 */
export const hoistSystemMessagesMiddleware: LanguageModelV3Middleware = {
  specificationVersion: "v3",
  transformParams: ({ params }: { params: LanguageModelV3CallOptions }) => {
    const prompt = params.prompt;
    let boundary = 0;
    while (boundary < prompt.length && prompt[boundary]?.role === "system") boundary += 1;
    const tail = prompt.slice(boundary);
    const displaced = tail.filter((m) => m.role === "system");
    if (displaced.length === 0) return Promise.resolve(params);
    return Promise.resolve({
      ...params,
      prompt: [
        ...prompt.slice(0, boundary),
        ...displaced,
        ...tail.filter((m) => m.role !== "system"),
      ],
    });
  },
};

/**
 * Promote a stranded `reasoning_content` to a text part. Ported verbatim from
 * Kioku's `apps/api/src/llm.ts` so openai-compatible callers lose no behavior:
 * thinking-mode models (GLM/Qwen on LM Studio) sometimes emit their final
 * structured output into the reasoning channel and leave assistant `content`
 * empty, which makes `generateObject` throw `AI_NoObjectGeneratedError`. When
 * there is no non-empty text part but there are reasoning parts, concat the
 * reasoning text into a single text part. Tool-call parts are untouched.
 */
export const reasoningRepairMiddleware: LanguageModelV3Middleware = {
  specificationVersion: "v3",
  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();
    const hasText = result.content.some((p) => p.type === "text" && p.text.trim().length > 0);
    if (hasText) return result;
    const reasoning = result.content
      .filter((p): p is { type: "reasoning"; text: string } => p.type === "reasoning")
      .map((p) => p.text)
      .join("");
    if (reasoning.trim().length === 0) return result;
    return {
      ...result,
      content: [
        ...result.content.filter((p) => p.type !== "text" && p.type !== "reasoning"),
        { type: "text", text: reasoning },
      ],
    };
  },
};
