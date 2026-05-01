import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";

type UnifiedFinishReason = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";

export interface MockLlmScript {
  /** Plain text the model should "say" in this turn. */
  text?: string;
  /** Tool calls the model should emit. */
  toolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    /** Object form — will be JSON.stringify'd into the input string the SDK expects. */
    input: unknown;
  }>;
  /**
   * Stop reason. Defaults to "tool-calls" when toolCalls are present, otherwise "stop".
   */
  finishReason?: UnifiedFinishReason;
}

const EMPTY_USAGE: LanguageModelV3GenerateResult["usage"] = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/**
 * Build a `MockLanguageModelV3` (Vercel AI SDK v6) that yields a sequence of
 * scripted responses, one per `generate` call. After the script is exhausted,
 * further calls throw — keeps tests honest about how many turns they expect.
 */
export function mockLLM(scripts: MockLlmScript[]): MockLanguageModelV3 {
  let cursor = 0;
  return new MockLanguageModelV3({
    doGenerate: (): Promise<LanguageModelV3GenerateResult> => {
      if (cursor >= scripts.length) {
        throw new Error(
          `mockLLM: script exhausted after ${String(scripts.length)} call(s) — test invoked the model more times than expected`,
        );
      }
      const script = scripts[cursor++];
      const content: LanguageModelV3GenerateResult["content"] = [];
      if (script.text != null) {
        content.push({ type: "text", text: script.text });
      }
      for (const call of script.toolCalls ?? []) {
        content.push({
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: JSON.stringify(call.input),
        });
      }
      const unified: UnifiedFinishReason =
        script.finishReason ?? (script.toolCalls?.length ? "tool-calls" : "stop");
      return Promise.resolve({
        content,
        finishReason: { unified, raw: undefined },
        usage: EMPTY_USAGE,
        warnings: [],
      });
    },
  });
}
