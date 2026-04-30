# Telegram Platform Adapter

The platform layer abstracts messaging services behind a common interface. Telegram is implemented via Grammy long-polling. iMessage (via BlueBubbles) is also supported — see [imessage.md](imessage.md). Both adapters are registered in `apps/bot/src/platform/registry.ts::AdapterRegistry`, which the schedulers use to route messages by `platformForChatId(chatId)`.

## PlatformAdapter Interface

Defined in `packages/shared/src/types.ts`:

```typescript
interface PlatformAdapter {
  readonly platform: string;
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
  timestamp: Date;
  replyToMessageId?: string;
}
```

## TelegramAdapter

Implemented in `apps/bot/src/platform/telegram/adapter.ts`. Singleton accessed via `getAdapter()`.

### Methods

| Method                                                 | Description                                                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normalize(ctx)`                                       | Extract text message from Grammy context → `IncomingMessage`                                                                                                              |
| `normalizePhoto(ctx)`                                  | Download photo from Telegram API, convert to base64, detect MIME type → `IncomingMessage`                                                                                 |
| `normalizeLocation(ctx)`                               | Extract location from message → `IncomingMessage` with `location` field                                                                                                   |
| `normalizeLocationEdit(ctx)`                           | Extract location from edited message (live location update) → `IncomingMessage`                                                                                           |
| `sendText(chatId, text)`                               | Send plain text message                                                                                                                                                   |
| `sendPhoto(chatId, photo, caption)`                    | Send photo by file path or file_id. Returns file_id for caching.                                                                                                          |
| `sendPhotoBuffer(chatId, buffer, caption)`             | Send photo from memory buffer. Returns file_id.                                                                                                                           |
| `sendVoiceBuffer(chatId, buffer, duration?)`           | Send voice message from buffer (used by the `sendVoice` tool).                                                                                                            |
| `sendConfirmationPrompt(chatId, text, confirmationId)` | Send a message with `[✓ Approve][✗ Deny]` inline buttons. Callback data is `confirm:<confirmationId>:<approve\|deny>`. Returns the platform message id for later editing. |
| `editConfirmationPrompt(chatId, messageId, text)`      | Replace a confirmation prompt's body with a terminal-state line and clear the inline keyboard. Tolerant of failures (user may have deleted the message).                  |

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
    │   ├─ Send typing action
    │   ├─ handleMessage(incoming, adapter)
    │   └─ resetTimer(chatId)
    │
    ├─ message:photo handler
    │   ├─ normalizePhoto(ctx) → IncomingMessage (with base64 image)
    │   ├─ Rate limit check
    │   ├─ Send typing action
    │   ├─ handleMessage(incoming, adapter)
    │   └─ resetTimer(chatId)
    │
    ├─ message:voice handler / message:audio handler (see docs/voice.md)
    │   ├─ normalizeVoice/normalizeAudio(ctx) → IncomingMessage with audioBuffer + duration
    │   ├─ Rate limit check
    │   ├─ Send typing action
    │   ├─ handleMessage(incoming, adapter) — transcribes via STT if configured
    │   └─ resetTimer(chatId)
    │
    ├─ message:location handler (gated on LOCATION_ENABLED)
    │   ├─ normalizeLocation(ctx) → IncomingMessage (with location)
    │   ├─ Rate limit check
    │   ├─ processLocation() → geocode, store, detect events
    │   ├─ handleMessage(incoming, adapter) — full AI pipeline
    │   ├─ resetTimer(chatId)
    │   └─ If arrival event → triggerLocationProactive(chatId)
    │
    ├─ edited_message:location handler (gated on LOCATION_ENABLED)
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

## Extending to a New Platform

To add a new platform (e.g., Discord):

1. **Create adapter** at `apps/bot/src/platform/discord/adapter.ts`
   - Implement the `PlatformAdapter` interface (from `@mashiro/shared`)
   - Handle message normalization to `IncomingMessage`

2. **Create bot setup** at `apps/bot/src/platform/discord/bot.ts`
   - Register event handlers for the platform's SDK
   - Apply rate limiting and allowlist logic
   - Call `handleMessage()` from `apps/bot/src/ai/generate.ts`
   - Call `resetTimer()` to integrate with the proactive scheduler

3. **Wire into entry point** (`apps/bot/src/index.ts`)
   - Initialize the new adapter alongside or instead of Telegram
   - Pass it to the proactive scheduler

The AI layer (`apps/bot/src/ai/`) is platform-agnostic — it only uses `PlatformAdapter` and `IncomingMessage` from `@mashiro/shared`, so no changes are needed there.
