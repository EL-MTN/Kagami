import { experimental_generateSpeech as generateSpeech } from "ai";
import { openai } from "@ai-sdk/openai";
import { config, logger } from "@kokoro/shared";
import type { GeneratedAudio } from "../types";

export async function generateWithOpenAi(text: string, modelId: string): Promise<GeneratedAudio> {
  const voiceId = config.TTS_VOICE_ID!;
  const start = Date.now();

  const result = await generateSpeech({
    model: openai.speech(modelId),
    text,
    voice: voiceId,
    outputFormat: "opus",
    abortSignal: AbortSignal.timeout(30_000),
  });

  const elapsed = Date.now() - start;
  logger.debug(
    { model: modelId, voice: voiceId, elapsed, mediaType: result.audio.mediaType },
    "OpenAI TTS generated",
  );

  return {
    buffer: Buffer.from(result.audio.uint8Array),
    mediaType: result.audio.mediaType,
  };
}
