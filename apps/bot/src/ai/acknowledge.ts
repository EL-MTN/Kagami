import { generateText } from "ai";
import { getModel, getModelName } from "./provider";
import { assembleSystemPrompt, assembleMessages } from "./context-assembler";
import { ACKNOWLEDGMENT_INSTRUCTIONS } from "./prompts";
import { getOrCreateSession, appendMessage } from "@mashiro/db";
import { logger } from "@mashiro/shared";
import type { PlatformAdapter } from "@mashiro/shared";
import { sendSegmented } from "./response";
import { trackUsage } from "./token-tracker";
import { platformForChatId } from "../platform/registry";

const LLM_TIMEOUT_MS = 60_000;

/**
 * Generate a brief in-character acknowledgment after a confirmation has been
 * resolved. Runs as a one-shot LLM turn driven by the bracketed resolution
 * event that was just appended to conversation history. Output is intended
 * to be a single short bubble — the directive in the system prompt asks the
 * model to keep it terse and avoid re-narrating the action.
 *
 * Tools are intentionally NOT passed. The directive says "don't call any
 * more tools — this turn is just for speaking" and we enforce that at the
 * code level rather than relying on prompt compliance: with tools available,
 * a misbehaving model could call requestConfirmation here and create a
 * confirmation-of-a-confirmation loop.
 *
 * Errors here are non-fatal — the bracketed event already lives in
 * conversation history, so Mashiro can still reference the resolution on
 * the next user-driven turn.
 */
export async function generateAcknowledgment(
  chatId: string,
  userId: string,
  adapter: PlatformAdapter,
): Promise<void> {
  const { conversation } = await getOrCreateSession(chatId, userId, platformForChatId(chatId));
  const sessionId = conversation.sessionId;

  const [baseSystemPrompt, messages] = await Promise.all([
    assembleSystemPrompt(chatId, sessionId),
    assembleMessages(chatId),
  ]);

  const systemPrompt = `${baseSystemPrompt}\n\n---\n\n${ACKNOWLEDGMENT_INSTRUCTIONS}`;

  // The bracketed event was just appended as a user-role message, so the
  // history already ends correctly for the model.

  const result = await generateText({
    model: getModel(),
    system: systemPrompt,
    messages,
    temperature: 0.6,
    abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  trackUsage("conversation", getModelName(), result.usage, {
    chatId,
    sessionId,
  });

  const responseText = result.text;
  if (!responseText) {
    logger.debug({ chatId }, "Acknowledgment turn produced no text");
    return;
  }

  await appendMessage(conversation, {
    role: "assistant",
    content: responseText,
    timestamp: new Date(),
  });

  await sendSegmented(adapter, chatId, responseText);
}
