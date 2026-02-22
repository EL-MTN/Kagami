import { generateText } from "ai";
import { getModel } from "./provider.js";
import { assembleSystemPrompt, assembleMessages } from "./context-assembler.js";
import { allTools, type ToolContext } from "./tools/index.js";
import {
  getOrCreateConversation,
  appendMessage,
} from "../db/models/conversation.js";
import type { IncomingMessage, PlatformAdapter } from "../platform/types.js";
import { logger } from "../utils/logger.js";

export async function handleMessage(
  incoming: IncomingMessage,
  adapter: PlatformAdapter,
): Promise<void> {
  // 1. Get/create conversation and save user message
  const convo = await getOrCreateConversation(
    incoming.chatId,
    incoming.userId,
    incoming.platform,
  );

  await appendMessage(convo, {
    role: "user",
    content: incoming.text,
    timestamp: incoming.timestamp,
  });

  // 2. Build system prompt and message history
  const [systemPrompt, messages] = await Promise.all([
    assembleSystemPrompt(),
    assembleMessages(incoming.chatId),
  ]);

  logger.debug(
    {
      systemPromptLength: systemPrompt.length,
      messageCount: messages.length,
      lastMessage: messages.at(-1)?.content?.toString().slice(0, 80),
    },
    "Context assembled",
  );

  // 3. Create tool context
  const toolContext: ToolContext = {
    chatId: incoming.chatId,
    adapter,
  };

  // 4. Generate response with tools
  logger.debug("Calling generateText...");

  const result = await generateText({
    model: getModel(),
    system: systemPrompt,
    messages,
    tools: allTools(toolContext),
    maxSteps: 5,
  });

  // 5. Debug: log every step
  for (let i = 0; i < result.steps.length; i++) {
    const step = result.steps[i];
    logger.info(
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

  // 6. Extract response text — check all steps, not just result.text
  let responseText = result.text;
  if (!responseText) {
    // Walk steps in reverse to find the last one with text
    for (let i = result.steps.length - 1; i >= 0; i--) {
      if (result.steps[i].text) {
        responseText = result.steps[i].text;
        break;
      }
    }
  }

  if (!responseText) {
    logger.warn(
      {
        stepCount: result.steps.length,
        finishReason: result.finishReason,
      },
      "No text in any step — LLM produced no response",
    );
    responseText = "hmm, lost my train of thought for a sec. what were you saying?";
  }

  logger.info(
    {
      responseLength: responseText.length,
      responsePreview: responseText.slice(0, 120),
      totalSteps: result.steps.length,
      finishReason: result.finishReason,
    },
    "Final response",
  );

  // 7. Save assistant response
  const toolCalls = result.steps
    .flatMap((step) => step.toolCalls || [])
    .map((tc) => ({
      toolName: tc.toolName,
      args: tc.args as Record<string, unknown>,
    }));

  await appendMessage(convo, {
    role: "assistant",
    content: responseText,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    timestamp: new Date(),
  });

  // 8. Send response
  await adapter.sendText(incoming.chatId, responseText);
}
