# Telegram Platform Adapter

The platform layer abstracts messaging services behind a common interface. Telegram is implemented via Grammy long-polling. iMessage (via BlueBubbles) is also supported — see [imessage.md](imessage.md). Both adapters are registered in `apps/bot/src/platform/registry.ts::AdapterRegistry`, which the schedulers use to route messages by `platformForChatId(chatId)`.

## PlatformAdapter Interface

Defined in `packages/shared/src/types.ts`:

```typescript
type ActivityKind = "typing" | "upload_photo" | "record_voice" | "upload_voice" | "upload_document";

interface PlatformAdapter {
  readonly platform: string;
  // Optional capability: ephemeral chat-activity indicator ("typing…").
  // Telegram implements it via sendChatAction; iMessage omits it and the
  // heartbeat degrades to a no-op. See "Activity Indicators" below.
  sendActivity?(chatId: string, kind: ActivityKind): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
  sendPhoto(
    chatId: string,
    photo: { path?: string; fileId?: string },
    caption?: string,
  ): Promise<string | undefined>;
  sendPhotoBuffer(chatId: string, buffer: Buffer, caption?: string): Promise<string | undefined>;
  sendVoiceBuffer(chatId: string, buffer: Buffer, duration?: number): Promise<void>;
  sendConfirmationPrompt(
    chatId: string,
    text: string,
    confirmationId: string,
  ): Promise<string | undefined>;
  editConfirmationPrompt(chatId: string, messageId: string, text: string): Promise<void>;
}
```

### Message Types

```typescript
interface IncomingMessage {
  platform: string;
  chatId: string;
  userId: string;
  userName: string;
  text: string;
  imageBase64?: string;
  imageMimeType?: string;
  audioBuffer?: Buffer; // inbound voice notes / audio attachments
  audioMimeType?: string;
  audioDurationSeconds?: number;
  documentBuffer?: Buffer; // inbound generic files → workspace inbox/
  documentMimeType?: string;
  documentFileName?: string;
  timestamp: Date;
  replyToMessageId?: string;
  location?: {
    latitude: number;
    longitude: number;
    heading?: number;
    accuracy?: number;
    livePeriod?: number;
  };
}
```

## TelegramAdapter

Implemented in `apps/bot/src/platform/telegram/adapter.ts`. Singleton accessed via `getAdapter()`.

### Methods

| Method                                                          | Description                                                                                                                                                                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `normalize(ctx)`                                                | Extract text message from Grammy context → `IncomingMessage`                                                                                                                                                                                     |
| `normalizePhoto(ctx)`                                           | Download photo from Telegram API, convert to base64, detect MIME type → `IncomingMessage`                                                                                                                                                        |
| `normalizeDocument(ctx)`                                        | Download a generic file attachment (PDF/CSV/…) → `IncomingMessage` with `documentBuffer`/`documentMimeType`/`documentFileName`. Files over the Bot API's 20 MB bot-download cap return an honest `[file … too large to receive]` marker instead. |
| `normalizeLocation(ctx)`                                        | Extract location from message → `IncomingMessage` with `location` field                                                                                                                                                                          |
| `normalizeLocationEdit(ctx)`                                    | Extract location from edited message (live location update) → `IncomingMessage`                                                                                                                                                                  |
| `sendText(chatId, text)`                                        | Send plain text message                                                                                                                                                                                                                          |
| `sendPhoto(chatId, photo, caption)`                             | Send photo by file path or file_id. Returns file_id for caching.                                                                                                                                                                                 |
| `sendPhotoBuffer(chatId, buffer, caption)`                      | Send photo from memory buffer. Returns file_id.                                                                                                                                                                                                  |
| `sendVoiceBuffer(chatId, buffer, duration?)`                    | Send voice message from buffer (used by the `sendVoice` tool).                                                                                                                                                                                   |
| `sendFileBuffer(chatId, buffer, fileName, mimeType?, caption?)` | Send any buffer as a document attachment via `sendDocument` (used by the `sendFile` workspace tool). Telegram sniffs the content type; the InputFile name is what the recipient sees.                                                            |
| `sendConfirmationPrompt(chatId, text, confirmationId)`          | Send a message with `[✓ Approve][✗ Deny]` inline buttons. Callback data is `confirm:<confirmationId>:<approve\|deny>`. Returns the platform message id for later editing.                                                                        |
| `editConfirmationPrompt(chatId, messageId, text)`               | Replace a confirmation prompt's body with a terminal-state line and clear the inline keyboard. Tolerant of failures (user may have deleted the message).                                                                                         |

### Photo Handling

- Photos are downloaded via Telegram's `getFile` API
- MIME type detected from extension (`.png` → `image/png`, else `image/jpeg`)
- Downloaded images are passed as base64 in `IncomingMessage`; the AI layer writes them to MongoDB GridFS and stores only an `imageRef` key in the conversation document
- Returned `file_id` values can be reused to avoid re-uploading

## Bot Setup

Implemented in `apps/bot/src/platform/telegram/bot.ts`.

### Handler Registration

```
createBot(token)
    │
    ├─ Allowlist middleware (if ALLOWED_USER_IDS configured)
    │
    ├─ /clear command
    │   └─ Deletes all active conversations → replies "Context cleared — starting fresh."
    │
    ├─ message:text handler
    │   ├─ normalize(ctx) → IncomingMessage
    │   ├─ Rate limit check
    │   ├─ handleMessage(incoming, adapter) — owns the activity heartbeat
    │   └─ resetTimer(chatId)
    │
    ├─ message:photo handler
    │   ├─ normalizePhoto(ctx) → IncomingMessage (with base64 image)
    │   ├─ Rate limit check
    │   ├─ handleMessage(incoming, adapter) — owns the activity heartbeat
    │   └─ resetTimer(chatId)
    │
    ├─ message:voice handler / message:audio handler (see docs/voice.md)
    │   ├─ normalizeVoice/normalizeAudio(ctx) → IncomingMessage with audioBuffer + duration
    │   ├─ Rate limit check
    │   ├─ handleMessage(incoming, adapter) — transcribes via STT if configured; owns the activity heartbeat
    │   └─ resetTimer(chatId)
    │
    ├─ message:document handler
    │   ├─ normalizeDocument(ctx) → IncomingMessage with documentBuffer + fileName (20 MB Bot API cap)
    │   ├─ Rate limit check
    │   ├─ handleMessage(incoming, adapter) — saves to workspace inbox/ (or placeholders when disabled)
    │   └─ resetTimer(chatId)
    │
    ├─ message:location handler
    │   ├─ normalizeLocation(ctx) → IncomingMessage (with location)
    │   ├─ Rate limit check
    │   ├─ processLocation() → geocode, store, detect events
    │   ├─ handleMessage(incoming, adapter) — full AI pipeline
    │   ├─ resetTimer(chatId)
    │   └─ If arrival event → triggerLocationProactive(chatId)
    │
    ├─ edited_message:location handler
    │   ├─ normalizeLocationEdit(ctx) → IncomingMessage (live update)
    │   ├─ processLocation() — silent store only (no AI pipeline)
    │   └─ If arrival event → triggerLocationProactive(chatId)
    │
    └─ callback_query:data handler (confirmation buttons)
        ├─ Parse `confirm:<id>:<approve|deny>` callback data
        ├─ Reject if no ctx.chat (defensive — single-user bot doesn't use inline mode)
        ├─ Load PendingConfirmation, validate chat-scope + status + expiry
        ├─ resolvePendingConfirmation(...) ← atomic, BEFORE dispatch
        ├─ answerCallbackQuery({ text: "Working…" / "Denied" }) ← dismiss spinner
        ├─ If approved: dispatchGatedAction(action.tool, action.args)
        ├─ adapter.editConfirmationPrompt → terminal-state line, keyboard cleared
        ├─ appendConfirmationResolution → bracketed event in conversation history
        └─ generateAcknowledgment (fire-and-forget) → in-character one-bubble reply
```

### Allowlist Middleware

When `ALLOWED_USER_IDS` is configured in env:

- Only listed user IDs pass through
- Unauthorized attempts are logged and silently dropped

### Rate Limiting

- **Window**: 1 minute (sliding)
- **Limit**: 15 messages per user per minute
- **Storage**: in-memory `Map<userId, timestamp[]>` (resets on restart, stale entries evicted periodically)
- Exceeding the limit returns an error reply to the user

### Error Handling

Both handlers catch errors and reply with a fallback message so the bot doesn't crash on failures.

## Activity Indicators

Telegram chat actions ("typing…" under the chat name and in the chat list)
self-expire after ~5 seconds, while a conversational turn routinely runs
30s+ across up to five agentic steps. Kokoro therefore runs a **heartbeat**
per user-facing turn instead of one-shot actions:

- `startActivity(adapter, chatId)` (`src/services/activity.ts`) emits
  `typing` immediately, re-emits the current verb every 4.5s, and stops in
  `handleMessage`'s `finally`. The acknowledgment turn (post-Approve) gets
  the same treatment. Every emit is fail-open — an indicator must never
  break a turn.
- **Stage-aware verbs**: long media tools switch the verb while they run,
  via a wrapper applied at the bottom of `allTools` (`ai/tools/index.ts`):
  `sendPhoto` → `upload_photo` ("sending a photo…"), `sendVoice` →
  `record_voice` ("recording a voice message…"). Afterwards the wrapper
  resets to `typing` for the next LLM step — except when the tool's output
  was itself (likely) the final user-visible act: a successful `sendPhoto`
  (or `browse` delivering a screenshot) may suppress the final text bubble
  (`wasPhotoSent` in `ai/response.ts`), so the heartbeat **pauses** instead
  of promising a message that may never come; the next `set()` revives it. Fast tools
  (sub-3s reads) are deliberately unmapped — switching for them is invisible
  flicker. Parallel tool calls are last-write-wins; Telegram renders a
  single verb.
- **Scope**: only paths where a user is watching the chat. Routine
  executions, watcher ticks, and proactive outreach get no indicator — an
  unprompted "typing…" before a scheduled message reads as uncanny.
- The verb set (`ActivityKind`) is a deliberate subset of Telegram's union:
  only verbs Kokoro can honestly promise (the action is a promise about
  what the user is about to receive). iMessage has no adapter support
  today, so the heartbeat is inert there.

## Extending to a New Platform

To add a new platform (e.g., Discord):

1. **Create adapter** at `apps/bot/src/platform/discord/adapter.ts`
   - Implement the `PlatformAdapter` interface (from `@kokoro/shared`)
   - Handle message normalization to `IncomingMessage`

2. **Create bot setup** at `apps/bot/src/platform/discord/bot.ts`
   - Register event handlers for the platform's SDK
   - Apply rate limiting and allowlist logic
   - Call `handleMessage()` from `apps/bot/src/ai/generate.ts`
   - Call `resetTimer()` to integrate with the proactive scheduler

3. **Wire into entry point** (`apps/bot/src/index.ts`)
   - Initialize the new adapter alongside or instead of Telegram
   - Pass it to the proactive scheduler

The AI layer (`apps/bot/src/ai/`) is platform-agnostic — it only uses `PlatformAdapter` and `IncomingMessage` from `@kokoro/shared`, so no changes are needed there.
