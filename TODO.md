# Mashiro — TODO

## New Features

- [x] **Voice Messages** — Speech synthesis via ElevenLabs and OpenAI TTS, sent as Telegram voice notes
- [ ] **Voice Input Understanding** — Accept and transcribe incoming voice messages (Whisper API) instead of silently ignoring `message:voice`
- [ ] **Mood / Emotional State Tracking** — Maintain a persistent mood state that evolves based on conversation tone, time since last interaction, and events; influences response style, selfie expressions, and proactive frequency
- [x] **Photo Reactions & Image Understanding** — Handle incoming photos with a vision model to respond contextually (food, places, selfies, etc.)
- [x] **Calendar Awareness & Date Memory** — Google Calendar integration with full CRUD via LLM tool
- [x] **Gmail Integration** — Read-only email access with unread listing and full body retrieval via LLM tool
- [x] **Reminder System** — MongoDB-backed reminders with polling scheduler, scoped per chat, LLM-composed messages
- [ ] **Sticker / GIF Responses** — Curate anime stickers/GIFs that Mashiro sends contextually via Telegram's sticker support
- [x] **Location-Aware Context** — Reverse geocoding, arrival detection, location context in system prompt
- [ ] **Weather API Integration** — Add weather data to location-aware context when user shares location
- [ ] **Multi-Platform Support (Discord)** — Implement a Discord adapter using the existing `PlatformAdapter` interface
- [ ] **Conversation Recap Command** — A `/recap` command that summarizes recent conversations from vault summaries
- [ ] **Dynamic Personality Evolution** — Evolve the personality card over time based on relationship milestones

## Architecture & Code Quality

- [x] **Extract shared response-sending logic** — Deduplicated into `src/ai/response.ts` (`extractResponseText`, `collectToolCalls`, `wasPhotoSent`, `sendSegmented`, `logSteps`)
- [ ] **Add a test suite** — Unit tests for `vault.ts`, `markdown.ts`, `context-assembler.ts`, `curator.ts`, and proactive scheduler timing logic
- [x] **Remove photo cache** — Removed MediaAsset model and all prompt-hash caching (prompts never realistically collide)
- [x] **Make curation non-blocking** — Curation runs as fire-and-forget with per-chat mutex
- [x] **Fix cross-day conversation continuity** — Replaced daily scoping with idle-based sessions (4h threshold)
- [x] **Use async I/O in `loadContext()`** — Replaced all sync fs calls with `fs/promises` and parallelized directory loading
- [x] **Clean up dead code** — Removed unused `sendPhotoWithCache` in `helpers.ts`
- [x] **Use all reference images** — Apply LLM selection for face/body refs (like outfits) or simplify to single-value variables

## Reliability & Ops

- [ ] **Add health checks / monitoring** — Lightweight HTTP health endpoint or periodic heartbeat logging
- [ ] **Add CI/CD** — GitHub Actions pipeline for `typecheck` + `lint` on PRs and auto-deploy on main push
- [x] **Improve image generation error context** — Error messages from image providers are now bubbled to the LLM so it can explain failures
- [ ] **Persist rate limiting** — Move the in-memory rate limiter to MongoDB or Redis so it survives restarts

## Security

- [ ] **Move "MGK" testing override** — Relocate the all-bypass keyword from the committed personality card to an uncommitted `.env` variable or gitignored file
