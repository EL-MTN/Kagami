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
        args: (tc.input ?? {}) as Record<string, unknown>,
        result: tr ? JSON.stringify(tr.output) : undefined,
      };
    });
  });
}

/**
 * Check whether a photo was the only meaningful tool interaction.
 * Returns true only when sendPhoto/browse-screenshot sent a photo AND
 * no other tools (like browse search/visit) were used — avoids skipping
 * substantive text responses that accompany tool-heavy flows.
 */
export function wasPhotoSent(steps: Step[]): boolean {
  const allResults = steps.flatMap((s) => s.toolResults ?? []);
  const photoSent = allResults.some(
    (tr) =>
      (tr.toolName === "sendPhoto" && (tr.output as { sent?: boolean })?.sent) ||
      (tr.toolName === "browse" && (tr.output as { sent?: boolean })?.sent),
  );
  if (!photoSent) return false;

  // If there were other tool calls besides photo-sending ones, don't skip text
  const hasOtherTools = allResults.some(
    (tr) =>
      tr.toolName !== "sendPhoto" &&
      !(tr.toolName === "browse" && (tr.output as { sent?: boolean })?.sent),
  );
  return !hasOtherTools;
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
