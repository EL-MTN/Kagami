import { experimental_generateSpeech as generateSpeech } from "ai";
import { elevenlabs } from "@ai-sdk/elevenlabs";
import { config, logger } from "@kokoro/shared";
import type { GeneratedAudio } from "../types";

export async function generateWithElevenLabs(
  text: string,
  modelId: string,
): Promise<GeneratedAudio> {
  const voiceId = config.TTS_VOICE_ID!;
  const start = Date.now();

  const result = await generateSpeech({
    model: elevenlabs.speech(modelId),
    text,
    voice: voiceId,
    outputFormat: "opus_48000_64",
    providerOptions: {
      elevenlabs: {
        voiceSettings: {
          stability: 0.4,
          similarityBoost: 0.9,
          style: 0.5,
          speed: 1.15,
        },
      },
    },
    abortSignal: AbortSignal.timeout(30_000),
  });

  const elapsed = Date.now() - start;
  logger.debug(
    { model: modelId, voice: voiceId, elapsed, mediaType: result.audio.mediaType },
    "ElevenLabs TTS generated",
  );

  return {
    buffer: Buffer.from(result.audio.uint8Array),
    mediaType: result.audio.mediaType,
  };
}
