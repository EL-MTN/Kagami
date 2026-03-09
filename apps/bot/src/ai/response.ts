import type { StepResult } from "ai";
import type { PlatformAdapter } from "@mashiro/shared";
import { logger } from "@mashiro/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Step = StepResult<any>;

/**
 * Walk steps in reverse to find the last one with text.
 * Falls back to result.text behavior (last step) when called with the full array.
 */
export function extractResponseText(steps: Step[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].text) return steps[i].text;
  }
  return undefined;
}

/**
 * Flatten all tool calls (with their results) across every step.
 */
export function collectToolCalls(steps: Step[]) {
  return steps.flatMap((step) => {
    return (step.toolCalls || []).map((tc) => {
      const tr = step.toolResults?.find((r) => r.toolCallId === tc.toolCallId);
      return {
        toolName: tc.toolName,
        args: tc.args as Record<string, unknown>,
        result: tr ? JSON.stringify(tr.result) : undefined,
      };
    });
  });
}

/**
 * Check whether any step successfully sent a photo (so we can skip text delivery).
 */
export function wasPhotoSent(steps: Step[]): boolean {
  return steps.some((step) =>
    step.toolResults?.some(
      (tr) =>
        (tr.toolName === "sendPhoto" && (tr.result as { sent?: boolean })?.sent) ||
        (tr.toolName === "browse" && (tr.result as { sent?: boolean })?.sent),
    ),
  );
}

/**
 * Send text split on double-newlines as separate message bubbles.
 */
export async function sendSegmented(
  adapter: PlatformAdapter,
  chatId: string,
  text: string,
): Promise<void> {
  const segments = text.split("\n\n").filter((s) => s.trim());
  for (const segment of segments) {
    await adapter.sendText(chatId, segment);
  }
}

/**
 * Log details for each LLM step (tool calls, text, finish reason).
 */
export function logSteps(steps: Step[]): void {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    logger.debug(
      {
        step: i,
        hasText: !!step.text,
        textPreview: step.text?.slice(0, 100) || "(empty)",
        toolCallCount: step.toolCalls?.length ?? 0,
        toolCalls: step.toolCalls?.map((tc) => tc.toolName),
        finishReason: step.finishReason,
      },
      `LLM step ${i}`,
    );
  }
}
