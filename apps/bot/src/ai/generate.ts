import { generateText } from "ai";
import { getModel } from "./provider.js";
import { assembleSystemPrompt, assembleMessages } from "./context-assembler.js";
import { allTools, type ToolContext } from "./tools/index.js";
import { getOrCreateSession, appendMessage, writeImage, generateImageKey } from "@mashiro/db";
import { curateIfNeeded, curateClosedSession } from "../memory/curator.js";
import type { IncomingMessage, PlatformAdapter } from "@mashiro/shared";
import { logger } from "@mashiro/shared";
import {
  extractResponseText,
  collectToolCalls,
  wasPhotoSent,
  sendSegmented,
  logSteps,
} from "./response.js";

const LLM_TIMEOUT_MS = 120_000; // 2 minutes

export async function handleMessage(
  incoming: IncomingMessage,
  adapter: PlatformAdapter,
): Promise<void> {
  // 1. Get/create session (replaces daily conversation scoping)
  const { conversation: convo, previouslyClosed } = await getOrCreateSession(
    incoming.chatId,
    incoming.userId,
    incoming.platform,
  );

  const sessionId = convo.sessionId;

  // Curate the previous session in background if it was just closed
  if (previouslyClosed) {
    curateClosedSession(previouslyClosed).catch((err) => {
      logger.error({ err, chatId: incoming.chatId }, "Background session curation failed");
    });
  }

  // Store image in GridFS if present, keep only a reference in the conversation doc
  let imageRef: string | undefined;
  if (incoming.imageBase64) {
    imageRef = generateImageKey();
    await writeImage(
      imageRef,
      Buffer.from(incoming.imageBase64, "base64"),
      incoming.imageMimeType ?? "image/jpeg",
    );
  }

  await appendMessage(convo, {
    role: "user",
    content: incoming.text,
    imageRef,
    imageMimeType: incoming.imageBase64 ? incoming.imageMimeType : undefined,
    timestamp: incoming.timestamp,
  });

  // 2. Fire-and-forget curation (non-blocking)
  curateIfNeeded(incoming.chatId).catch((err) => {
    logger.error({ err, chatId: incoming.chatId }, "Background curation failed");
  });

  // 3. Build system prompt and message history
  const [systemPrompt, messages] = await Promise.all([
    assembleSystemPrompt(sessionId),
    assembleMessages(incoming.chatId),
  ]);

  logger.debug(
    {
      systemPromptLength: systemPrompt.length,
      messageCount: messages.length,
      lastMessage: JSON.stringify(messages.at(-1)?.content)?.slice(0, 80),
    },
    "Context assembled",
  );

  // 4. Create tool context with sessionId
  const toolContext: ToolContext = {
    chatId: incoming.chatId,
    adapter,
    sessionId,
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
    abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
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
