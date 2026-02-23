import { generateText } from "ai";
import { getModel } from "./provider.js";
import { assembleSystemPrompt, assembleMessages } from "./context-assembler.js";
import { allTools, type ToolContext } from "./tools/index.js";
import { getOrCreateConversation, appendMessage } from "../db/models/conversation.js";
import { curateIfNeeded } from "../memory/curator.js";
import type { IncomingMessage, PlatformAdapter } from "../platform/types.js";
import { logger } from "../utils/logger.js";
import {
  extractResponseText,
  collectToolCalls,
  wasPhotoSent,
  sendSegmented,
  logSteps,
} from "./response.js";

export async function handleMessage(
  incoming: IncomingMessage,
  adapter: PlatformAdapter,
): Promise<void> {
  // 1. Get/create conversation and save user message
  const convo = await getOrCreateConversation(incoming.chatId, incoming.userId, incoming.platform);

  await appendMessage(convo, {
    role: "user",
    content: incoming.text,
    imageBase64: incoming.imageBase64,
    imageMimeType: incoming.imageMimeType,
    timestamp: incoming.timestamp,
  });

  // 2. Curate overflow messages before assembling context
  await curateIfNeeded(incoming.chatId);

  // 3. Build system prompt and message history
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

  // 4. Create tool context
  const toolContext: ToolContext = {
    chatId: incoming.chatId,
    adapter,
  };

  // 5. Generate response with tools
  logger.debug("Calling generateText...");

  const result = await generateText({
    model: getModel(),
    system: systemPrompt,
    messages,
    tools: allTools(toolContext),
    maxSteps: 5,
    temperature: 0.7,
  });

  // 6. Debug: log every step
  logSteps(result.steps);

  // 7. Extract response text
  let responseText = result.text || extractResponseText(result.steps);

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

  // 8. Save assistant response
  const toolCallData = collectToolCalls(result.steps);

  await appendMessage(convo, {
    role: "assistant",
    content: responseText,
    toolCalls: toolCallData.length > 0 ? toolCallData : undefined,
    timestamp: new Date(),
  });

  // 9. Send response — skip if sendPhoto already delivered the text as a caption
  if (!wasPhotoSent(result.steps)) {
    await sendSegmented(adapter, incoming.chatId, responseText);
  } else {
    logger.debug("Skipping sendText — photo with caption already sent");
  }
}
