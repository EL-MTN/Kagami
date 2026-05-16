import { generateText, stepCountIs } from "ai";
import { getModel } from "./provider";
import { assembleSystemPrompt, assembleMessages } from "./context-assembler";
import { allTools, type ToolContext } from "./tools/index";
import {
  getOrCreateSession,
  appendMessage,
  writeImage,
  generateImageKey,
  writeAudio,
  generateAudioKey,
} from "@kokoro/db";
import type { IncomingMessage, PlatformAdapter } from "@kokoro/shared";
import { logger } from "@kokoro/shared";
import { transcribeAudio } from "../stt/transcriber";
import {
  extractResponseText,
  collectToolCalls,
  wasPhotoSent,
  sendSegmented,
  logSteps,
} from "./response";
import { trackUsage } from "./token-tracker";
import { getModelName } from "./provider";
import { ingestClosedSession } from "@kokoro/memory";

const LLM_TIMEOUT_MS = 120_000; // 2 minutes

export async function handleMessage(
  incoming: IncomingMessage,
  adapter: PlatformAdapter,
): Promise<void> {
  // 1. Get/create session
  const { conversation: convo, previouslyClosed } = await getOrCreateSession(
    incoming.chatId,
    incoming.userId,
    incoming.platform,
  );

  // If a stale session just rolled over, ship its transcript to Kioku
  // for fact extraction. Fire-and-forget — we don't block the new turn
  // on the LLM-heavy ingest pipeline.
  if (previouslyClosed) {
    ingestClosedSession(previouslyClosed);
  }

  const sessionId = convo.sessionId;

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

  // Store inbound audio in GridFS and transcribe via STT (if configured).
  // The platform adapters set incoming.text to "[voice note]" as a default;
  // we overwrite it with the marker-prefixed transcript on success or with
  // a more specific placeholder on failure / oversize / disabled.
  //
  // Defense-in-depth: both adapters pre-filter audio at 25 MB before
  // populating audioBuffer, but we re-check here so an oversized buffer
  // from any future adapter never produces an orphan GridFS blob with no
  // transcript. transcribeAudio also has the same cap; this just makes
  // the "no GridFS write on oversized" guarantee structural rather than
  // adapter-coincidence.
  const STT_BYTE_CAP = 25 * 1024 * 1024;
  let audioRef: string | undefined;
  let audioDurationSeconds = incoming.audioDurationSeconds;
  let messageText = incoming.text;
  if (incoming.audioBuffer) {
    if (incoming.audioBuffer.length > STT_BYTE_CAP) {
      logger.warn(
        { bytes: incoming.audioBuffer.length, cap: STT_BYTE_CAP },
        "Audio reached handleMessage over cap; skipping GridFS write + transcription",
      );
      messageText = "[voice note too long to transcribe]";
    } else {
      audioRef = generateAudioKey();
      await writeAudio(audioRef, incoming.audioBuffer, incoming.audioMimeType ?? "audio/ogg");

      const outcome = await transcribeAudio({
        audio: incoming.audioBuffer,
        mimeType: incoming.audioMimeType ?? "audio/ogg",
        durationSeconds: incoming.audioDurationSeconds,
      });

      if (outcome.ok) {
        messageText = `[voice] ${outcome.text}`;
        audioDurationSeconds = outcome.durationSeconds ?? audioDurationSeconds;
      } else if (outcome.reason === "too-large") {
        messageText = "[voice note too long to transcribe]";
      } else if (outcome.reason === "failed") {
        messageText = "[voice note — transcription failed]";
      }
      // outcome.reason === "disabled": leave the adapter's "[voice note]" placeholder
    }
  }

  await appendMessage(convo, {
    role: "user",
    content: messageText,
    imageRef,
    imageMimeType: incoming.imageBase64 ? incoming.imageMimeType : undefined,
    audioRef,
    audioMimeType: audioRef ? incoming.audioMimeType : undefined,
    audioDurationSeconds: audioRef ? audioDurationSeconds : undefined,
    timestamp: incoming.timestamp,
  });

  // 2. Build system prompt and message history
  const [systemPrompt, messages] = await Promise.all([
    assembleSystemPrompt(incoming.chatId),
    assembleMessages(incoming.chatId),
  ]);

  const lastContent = messages.at(-1)?.content;
  const lastMessagePreview =
    typeof lastContent === "string"
      ? lastContent.slice(0, 80)
      : Array.isArray(lastContent)
        ? lastContent
            .map((part) => (part.type === "text" ? part.text.slice(0, 80) : `[${part.type}]`))
            .join(" ")
        : undefined;

  logger.debug(
    {
      systemPromptLength: systemPrompt.length,
      messageCount: messages.length,
      lastMessagePreview,
    },
    "Context assembled",
  );

  // 4. Create tool context with sessionId
  const toolContext: ToolContext = {
    chatId: incoming.chatId,
    adapter,
    sessionId,
    userId: incoming.userId,
  };

  // 5. Generate response with tools
  logger.debug("Calling generateText...");

  const result = await generateText({
    model: getModel(),
    system: systemPrompt,
    messages,
    tools: allTools(toolContext),
    stopWhen: stepCountIs(5),
    temperature: 0.7,
    abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  // 6. Track token usage + debug log
  trackUsage("conversation", getModelName(), result.usage, {
    chatId: incoming.chatId,
    sessionId,
    steps: result.steps.length,
  });
  logSteps(result.steps);

  // 7. Extract response text
  let responseText = result.text || extractResponseText(result.steps);

  if (!responseText) {
    logger.warn(
      {
        chatId: incoming.chatId,
        model: getModelName(),
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
