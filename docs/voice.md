# Voice input (STT)

Mashiro can transcribe inbound voice notes from Telegram and audio attachments from iMessage. Transcripts replace the original message text with a `[voice]` marker prefix so she knows the user spoke rather than typed and can react in character.

## Constraints

- **Opt-in via env vars.** With `STT_PROVIDER` unset, voice messages are surfaced as a `[voice note]` placeholder and the AI responds without a transcript. No surprise per-minute billing or local server requirement.
- **Single OpenAI-compatible provider.** Cloud (OpenAI) and local (whisper.cpp HTTP server) share one code path; only the `STT_BASE_URL` differs.
- **25 MB / 30-min cap** matching OpenAI Whisper's structural limit. Oversized audio surfaces as `[voice note too long to transcribe]` placeholder. Chunking deferred.
- **iMessage scope:** v1 supports voice notes from 1:1 DMs only and requires BlueBubbles to inline attachment data in the webhook payload. Group chats remain ignored per the existing iMessage-adapter contract.

## Architecture

```
apps/bot/src/stt/
├── types.ts              — SttRequest, TranscriptionResult, SttOutcome
├── transcriber.ts        — transcribeAudio() dispatcher with size + duration caps
└── providers/
    └── openai-stt.ts     — single provider via Vercel AI SDK's experimental_transcribe
```

Inbound flow:

```
Telegram message:voice / message:audio
     │
     │  (or)
     │
iMessage webhook with audio/* attachment
     │
     ▼
Adapter.normalizeVoice/Audio  →  IncomingMessage with audioBuffer + audioMimeType + audioDurationSeconds
     │
     ▼
handleMessage (apps/bot/src/ai/generate.ts)
     │
     ├─ if buffer > 25 MB: messageText = "[voice note too long to transcribe]"
     │     (skip writeAudio + transcribeAudio entirely — defense in depth)
     │
     └─ else:
        ├─ writeAudio(audioRef, buffer)  →  GridFS "audio" bucket
        ├─ transcribeAudio({ audio, mimeType, durationSeconds }) →  SttOutcome
        ├─ if ok: messageText = `[voice] ${transcript}`
        ├─ if too-large: messageText = "[voice note too long to transcribe]"
        ├─ if failed: messageText = "[voice note — transcription failed]"
        └─ if disabled: messageText = adapter's "[voice note]" placeholder
     │
     ▼
appendMessage with audioRef + audioMimeType + audioDurationSeconds
     │
     ▼
LLM sees `[voice] hey what's up` as the user message and responds
```

## Setup — local-first via whisper.cpp

The recommended setup runs whisper.cpp locally on the same Mac that hosts BlueBubbles. Free, private, fast on Apple Silicon.

### 1. Install whisper.cpp

```bash
brew install whisper-cpp
```

### 2. Download a model

```bash
# Recommended: Whisper Large-V3-Turbo — multilingual, ~5× realtime on M2/M3,
# ~1-2% accuracy gap vs full Large-V3.
mkdir -p ~/whisper-models
cd ~/whisper-models
curl -LO https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

### 3. Run the server

```bash
whisper-server \
  --model ~/whisper-models/ggml-large-v3-turbo.bin \
  --host 127.0.0.1 \
  --port 8089 \
  --inference-path /v1/audio/transcriptions
```

`whisper-server` exposes an OpenAI-compatible `/v1/audio/transcriptions` endpoint, so Mashiro talks to it the same way it talks to api.openai.com — only the base URL differs.

For a long-running setup, wrap this in a launchd plist on macOS so the server restarts at boot.

### 4. Configure Mashiro

Add to `apps/bot/.env`:

```env
STT_PROVIDER=openai/whisper-1
STT_BASE_URL=http://127.0.0.1:8089/v1
STT_API_KEY=local                  # whisper.cpp doesn't enforce auth; any non-empty string
```

Restart the bot. Send a voice note → bot logs `STT usage tracked` with `customEndpoint: true` and `estimatedCost: 0`.

## Setup — cloud Whisper

If you don't want to host the local server, use OpenAI's hosted Whisper:

```env
STT_PROVIDER=openai/whisper-1     # or openai/gpt-4o-transcribe
# OPENAI_API_KEY already set if you use other OpenAI features
```

Or upgrade to GPT-4o-Transcribe for better accent / noise handling at the same per-minute price:

```env
STT_PROVIDER=openai/gpt-4o-transcribe
```

Pricing (as of 2026-04): `whisper-1` and `gpt-4o-transcribe` are $0.006/min, `gpt-4o-mini-transcribe` is $0.003/min. Local models are tracked at $0.

## Storage

Original audio bytes are persisted to GridFS in a separate `audio` bucket (alongside the existing `images` bucket). The `IMessage.audioRef` field holds the GridFS key. This lets a future multimodal model re-feed the audio without a re-record. Audio refs are cleaned up the same way as image refs in `trimConversation` and `clearConversation`.

## Marker semantics

When the LLM sees `[voice] <transcript>` as the user message text, it knows the user spoke. The system prompt doesn't currently carry explicit guidance on this — the marker is intended to be read intuitively. Mashiro can react to tone if relevant ("you sound tired") or just respond to the content.

When transcription fails or is disabled, she sees one of:

- `[voice note]` — STT off; the user sent audio but it wasn't transcribed
- `[voice note too long to transcribe]` — exceeded 25 MB or 30 min
- `[voice note — transcription failed]` — provider threw

She'll typically apologize gracefully and ask for a retry.

## Token tracking

Each STT call writes a `TokenUsage` row with `category: "stt-transcription"`, the model id, the provider name, and `estimatedCost` computed as `(durationSeconds / 60) * perMinuteRate`. The dashboard `/usage` page picks it up automatically — no schema or aggregation changes needed.

Cost is zeroed whenever `STT_BASE_URL` is set, assuming a self-hosted whisper.cpp server (the documented local setup). If you point `STT_BASE_URL` at a paid hosted whisper-compatible service, this tracker will under-report — check your provider's invoice for ground truth or add a per-model entry to `STT_TRANSCRIPTION_PRICING` in `apps/bot/src/ai/token-tracker.ts` and remove the custom-endpoint short-circuit. A `WARN`-level log fires when a cloud call returns no duration (silent $0).

## What's deferred

- **Chunking** — files > 25 MB or > 30 min currently reject. ffmpeg-based chunking can come later.
- **Multimodal re-feed** — original audio is in GridFS but the context assembler doesn't currently feed it back to the LLM as audio content. A future feature when there's a concrete need for tone-aware re-reasoning.
- **Streaming transcription** — Whisper API and most local servers support streaming, but voice notes are typically short and the latency win isn't worth the complexity yet.
- **Speaker diarization** — single-speaker assumed; group voice notes (when iMessage groups land) would benefit.
