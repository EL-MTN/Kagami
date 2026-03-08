# Telegram Platform Adapter

The platform layer abstracts messaging services behind a common interface. Currently only Telegram is implemented via Grammy.

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

| Method                                     | Description                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `normalize(ctx)`                           | Extract text message from Grammy context → `IncomingMessage`                              |
| `normalizePhoto(ctx)`                      | Download photo from Telegram API, convert to base64, detect MIME type → `IncomingMessage` |
| `sendText(chatId, text)`                   | Send plain text message                                                                   |
| `sendPhoto(chatId, photo, caption)`        | Send photo by file path or file_id. Returns file_id for caching.                          |
| `sendPhotoBuffer(chatId, buffer, caption)` | Send photo from memory buffer. Returns file_id.                                           |

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
    │   └─ Deletes today's conversation → replies "Context cleared"
    │
    ├─ message:text handler
    │   ├─ normalize(ctx) → IncomingMessage
    │   ├─ Rate limit check
    │   ├─ Send typing action
    │   ├─ handleMessage(incoming, adapter)
    │   └─ resetTimer(chatId)
    │
    └─ message:photo handler
        ├─ normalizePhoto(ctx) → IncomingMessage (with base64 image)
        ├─ Rate limit check
        ├─ Send typing action
        ├─ handleMessage(incoming, adapter)
        └─ resetTimer(chatId)
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
