export interface SttRequest {
  audio: Buffer;
  mimeType: string;
  /** Optional duration hint when the platform surfaced it (Telegram does). */
  durationSeconds?: number;
}

export interface TranscriptionResult {
  text: string;
  /** Authoritative duration from the API response, when returned. */
  durationSeconds?: number;
}

/**
 * Discriminated outcome from `transcribeAudio`. The caller picks a
 * placeholder text from the reason code; see `apps/bot/src/ai/generate.ts`.
 *
 *   ok          → caller renders `[voice] <text>` and stores text + duration
 *   disabled    → STT_PROVIDER unset; caller leaves the adapter's placeholder
 *   too-large   → audio exceeded byte or duration cap; placeholder emitted
 *   failed      → transcription threw; caller emits a fallback placeholder
 */
export type SttOutcome =
  | { ok: true; text: string; durationSeconds?: number }
  | { ok: false; reason: "disabled" | "too-large" | "failed" };
