import { APICallError } from "ai";
import type { LanguageModelV3CallOptions, LanguageModelV3Middleware } from "@ai-sdk/provider";

/**
 * Per-attempt deadline. Merges a fresh `AbortSignal.timeout(ms)` into the
 * call's existing signal so the caller's own cancellation still wins. The
 * retry loop in fallback.ts re-invokes the wrapped leaf per attempt, so this
 * transform runs — and the budget resets — on every attempt.
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

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

/** Retryable iff the SDK flags it, the status is transient, or it timed out. */
export function isRetryable(err: unknown): boolean {
  if (APICallError.isInstance(err)) {
    return (
      err.isRetryable || (err.statusCode !== undefined && RETRYABLE_STATUS.has(err.statusCode))
    );
  }
  // Provider-imposed deadline (AbortSignal.timeout) surfaces as TimeoutError.
  return err instanceof Error && err.name === "TimeoutError";
}
