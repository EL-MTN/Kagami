import { generateText } from "ai";
import { getModel } from "./provider.js";
import { assembleSystemPrompt, assembleMessages } from "./context-assembler.js";
import { allTools, type ToolContext } from "./tools/index.js";
import {
  getOrCreateConversation,
  appendMessage,
} from "../db/models/conversation.js";
import { curateIfNeeded } from "../memory/curator.js";
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

  // 7. Extract response text — check all steps, not just result.text
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

  // 8. Save assistant response
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

  // 9. Send response — skip if sendPhoto already delivered the text as a caption
  const photoSent = result.steps.some((step) =>
    step.toolResults?.some(
      (tr) => tr.toolName === "sendPhoto" && (tr.result as { sent?: boolean })?.sent,
    ),
  );

  if (!photoSent) {
    const segments = responseText.split("\n\n").filter((s) => s.trim());
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) {
        const words = segments[i].split(/\s+/).length;
        const baseDelay = (words / 100) * 60_000; // ~100 WPM
        const delay = Math.min(Math.max(baseDelay * (0.8 + Math.random() * 0.4), 500), 4000);
        await new Promise((r) => setTimeout(r, delay));
      }
      await adapter.sendText(incoming.chatId, segments[i]);
    }
  } else {
    logger.debug("Skipping sendText — photo with caption already sent");
  }
}
