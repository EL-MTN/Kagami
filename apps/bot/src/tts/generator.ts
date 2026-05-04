import { config, logger } from "@kokoro/shared";
import { trackTtsGeneration } from "../ai/token-tracker";
import type { TtsRequest, GeneratedAudio } from "./types";

function parseProviderSpec(spec: string): { provider: string; modelId: string } {
  const slash = spec.indexOf("/");
  if (slash === -1) throw new Error(`Invalid TTS spec "${spec}" — expected "provider/model"`);
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

export async function generateVoice(req: TtsRequest): Promise<GeneratedAudio> {
  const spec = config.TTS_PROVIDER;
  if (!spec) throw new Error("TTS_PROVIDER is not configured");

  if (!config.TTS_VOICE_ID) throw new Error("TTS_VOICE_ID is not configured");

  const { provider, modelId } = parseProviderSpec(spec);
  const start = Date.now();

  let audio: GeneratedAudio;

  switch (provider) {
    case "elevenlabs": {
      const { generateWithElevenLabs } = await import("./providers/elevenlabs");
      audio = await generateWithElevenLabs(req.text, modelId);
      break;
    }
    case "openai": {
      const { generateWithOpenAi } = await import("./providers/openai-tts");
      audio = await generateWithOpenAi(req.text, modelId);
      break;
    }
    default:
      throw new Error(`Unsupported TTS provider "${provider}"`);
  }

  const elapsed = Date.now() - start;
  trackTtsGeneration(modelId, provider, req.text.length);
  logger.info({ provider, model: modelId, elapsed, chars: req.text.length }, "Voice generated");

  return audio;
}
