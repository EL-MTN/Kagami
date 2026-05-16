import { config, logger } from "@kokoro/shared";
import { trackSttTranscription } from "../ai/token-tracker";
import type { SttRequest, SttOutcome } from "./types";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // matches OpenAI Whisper cloud cap
const MAX_DURATION_SECONDS = 1800; // 30 min — Whisper cloud structural limit

function parseProviderSpec(spec: string): { provider: string; modelId: string } {
  const slash = spec.indexOf("/");
  if (slash === -1) {
    throw new Error(`Invalid STT spec "${spec}" — expected "provider/model"`);
  }
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

/**
 * Transcribe a buffer of audio. Returns a discriminated outcome so the
 * caller can pick the right placeholder text without re-running the
 * size/duration checks.
 *
 * Failure path is non-throwing — any underlying provider error is logged
 * and surfaced as `{ ok: false, reason: "failed" }`. The caller still
 * runs the AI pipeline with a fallback placeholder so Mashiro can react
 * gracefully ("hmm couldn't make out what you said").
 */
export async function transcribeAudio(req: SttRequest): Promise<SttOutcome> {
  if (!config.STT_PROVIDER) {
    return { ok: false, reason: "disabled" };
  }

  if (req.audio.length > MAX_AUDIO_BYTES) {
    logger.warn(
      { bytes: req.audio.length, cap: MAX_AUDIO_BYTES },
      "Audio exceeds size cap, skipping STT",
    );
    return { ok: false, reason: "too-large" };
  }
  if (req.durationSeconds !== undefined && req.durationSeconds > MAX_DURATION_SECONDS) {
    logger.warn(
      { durationSeconds: req.durationSeconds, cap: MAX_DURATION_SECONDS },
      "Audio exceeds duration cap, skipping STT",
    );
    return { ok: false, reason: "too-large" };
  }

  const start = Date.now();

  try {
    const { provider, modelId } = parseProviderSpec(config.STT_PROVIDER);
    switch (provider) {
      case "openai": {
        const { transcribeWithOpenAi } = await import("./providers/openai-stt");
        const result = await transcribeWithOpenAi(req.audio, req.mimeType, modelId);
        const elapsed = Date.now() - start;
        const durationSeconds = result.durationSeconds ?? req.durationSeconds;
        trackSttTranscription(modelId, provider, durationSeconds);
        logger.info(
          {
            provider,
            model: modelId,
            elapsedMs: elapsed,
            durationSeconds,
            chars: result.text.length,
          },
          "Audio transcribed",
        );
        return { ok: true, text: result.text, durationSeconds };
      }
      default:
        throw new Error(`Unsupported STT provider "${provider}"`);
    }
  } catch (error) {
    logger.error({ error: error, provider: config.STT_PROVIDER }, "STT transcription failed");
    return { ok: false, reason: "failed" };
  }
}
