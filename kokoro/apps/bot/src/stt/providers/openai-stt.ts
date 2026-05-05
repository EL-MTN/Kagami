import { experimental_transcribe as transcribe } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { config, logger } from "@kokoro/shared";
import type { TranscriptionResult } from "../types";

/**
 * Transcribe via the OpenAI-compatible `/v1/audio/transcriptions` endpoint.
 * Cloud and local share this provider — only the `baseURL` differs:
 *
 *   - Unset `STT_BASE_URL`     → defaults to api.openai.com (cloud Whisper / GPT-4o-Transcribe)
 *   - `STT_BASE_URL=http://127.0.0.1:8089/v1` → whisper.cpp's HTTP server
 *
 * The API key is taken from `STT_API_KEY` if set, falling back to
 * `OPENAI_API_KEY`. For local servers that don't enforce auth, any
 * non-empty string works (validated at startup).
 */
export async function transcribeWithOpenAi(
  audio: Buffer,
  mimeType: string,
  modelId: string,
): Promise<TranscriptionResult> {
  const provider = createOpenAI({
    // Use `||` so STT_API_KEY="" (the shape `STT_API_KEY=` produces in a
    // .env file) falls through to OPENAI_API_KEY — matches validateConfig
    // in @kokoro/shared, which would otherwise pass startup but then hand
    // an empty string to createOpenAI here and fail with auth errors.
    apiKey: config.STT_API_KEY || config.OPENAI_API_KEY,
    ...(config.STT_BASE_URL ? { baseURL: config.STT_BASE_URL } : {}),
  });

  const result = await transcribe({
    model: provider.transcription(modelId),
    audio,
    abortSignal: AbortSignal.timeout(120_000),
  });

  logger.debug(
    {
      modelId,
      durationSeconds: result.durationInSeconds,
      language: result.language,
      mimeType,
    },
    "OpenAI STT transcribed",
  );

  return {
    text: result.text,
    durationSeconds: result.durationInSeconds,
  };
}
