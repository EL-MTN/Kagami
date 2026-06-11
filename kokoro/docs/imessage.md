# iMessage (BlueBubbles)

Kokoro can run alongside Telegram on iMessage via [BlueBubbles](https://bluebubbles.app/), a self-hosted server that exposes a REST API for sending messages and a webhook for inbound events. The bot keeps Telegram fully functional; iMessage is opt-in via env vars.

## Constraints (read this first)

iMessage has no first-party API. Two limitations shape the design:

1. **No inline buttons.** The Telegram confirmation primitive uses `[Approve][Deny]` buttons. On iMessage, approval works via **text reply** — the user types `yes` or `no`. The webhook server runs a pre-AI parser that matches replies against the single pending confirmation in that chat.
2. **No third-party message editing.** `editConfirmationPrompt` cannot edit the original prompt bubble. The iMessage adapter sends a new message with the terminal-state line instead. The previous prompt bubble stays on screen.

v1 scope: **1:1 DMs only.** Group chats, reactions/tapbacks, and threaded replies are deferred.

## Architecture

```
apps/bot/src/platform/registry.ts          — AdapterRegistry + platformForChatId helper
apps/bot/src/platform/imessage/client.ts   — REST helpers: sendText, sendAttachment
apps/bot/src/platform/imessage/adapter.ts  — BlueBubblesAdapter implements PlatformAdapter
apps/bot/src/platform/imessage/webhook.ts  — node:http server; pre-AI YES/NO parser
```

Schedulers (`proactive`, `reminder`, `routine`, `watcher`) take an `AdapterRegistry` instead of a single `PlatformAdapter`. Each derives the platform from `chatId` via `platformForChatId(chatId)` and looks up the right adapter. Telegram chatIds are bare numeric strings; iMessage chatIds are stored with an `imessage:` prefix (e.g., `imessage:iMessage;-;+15551234567`). The prefix scheme means existing Telegram data needs no migration — the two namespaces can't collide.

The conversation model's `getOrCreateSession` is now scoped on `{chatId, platform}`. A new compound index `{chatId, platform, status, updatedAt}` backs the lookup.

## Setup

### 1. Run BlueBubbles on a Mac

Install BlueBubbles Server (https://bluebubbles.app/server) on the Mac that owns the iMessage account. Note the host (e.g., `http://192.168.1.10:1234`) and the server password.

### 2. Expose the bot's webhook port

The bot listens for inbound events on `BLUEBUBBLES_WEBHOOK_PORT` (default `4000`). For local development run a tunnel like `ngrok http 4000` or Cloudflare Tunnel. In production, expose the port via your reverse proxy.

### 3. Register the webhook in BlueBubbles

In the BlueBubbles Server UI, add the webhook URL:

```
https://<your-tunnel>.ngrok-free.app/webhook/bluebubbles?password=<BLUEBUBBLES_PASSWORD>
```

Subscribe to the `new-message` event. (The bot ignores everything else.)

### 4. Configure env vars

Add to `apps/bot/.env`:

```env
BLUEBUBBLES_HOST=http://192.168.1.10:1234
BLUEBUBBLES_PASSWORD=your-server-password
BLUEBUBBLES_WEBHOOK_PORT=4000               # default
ALLOWED_IMESSAGE_HANDLES=+15551234567       # comma-separated phone numbers / emails
```

Validation rules (enforced at startup):

- If `BLUEBUBBLES_HOST` is set, `BLUEBUBBLES_PASSWORD` is required.
- If `ALLOWED_IMESSAGE_HANDLES` is non-empty, `BLUEBUBBLES_HOST` is required.

The webhook authenticates each inbound POST against `BLUEBUBBLES_PASSWORD` (passed back as `?password=` or `X-Webhook-Token` header).

## Confirmation UX

Mashiro sends:

```
Approve action?

send email to alice@example.com about 3pm meeting

Reply YES to approve or NO to deny.
```

The user replies `yes` (or `y` / `approve` / `confirm`) → action runs. `no` (or `n` / `deny` / `reject` / `cancel`) → action denied.

Match rules:

- Reply must be **exactly** the keyword (case-insensitive), with at most a trailing `.` or `!` and surrounding whitespace. So `yes`, `Yes!`, `y.` all match; `yes I think so`, `yeah sure`, `no thanks`, `n/a` do **not** match and fall through to the AI pipeline. The strict match is intentional — gated tools include outbound email, calendar deletes, and browser-agent runs, so conversational uses of "yes" must not auto-resolve.
- **Exactly one** confirmation must be pending in the chat. If zero, the reply falls through to the AI pipeline. If multiple, the reply also falls through and Mashiro handles disambiguation conversationally — the system prompt's `## Pending Approvals` section keeps her aware.

After the verdict resolves, the same code path as Telegram runs: `dispatchGatedAction` → `attachResultText` → `editConfirmationPrompt` (which on iMessage sends a new message) → `appendConfirmationResolution` → `generateAcknowledgment` (one-shot LLM turn, no tools, in-character ack).

## Voice notes inbound

When `STT_PROVIDER` is configured (see [voice.md](voice.md)), inbound iMessage voice attachments are transcribed and the user message reaches Mashiro as `[voice] <transcript>`. The webhook decodes the inline base64 from `attachment.data`, applies the 25 MB cap, and stores the original audio in GridFS alongside the transcript. With STT disabled, voice attachments still surface as `[voice note]` placeholder and the AI pipeline runs normally.

## Inbox behavior summary

| Event                                 | Action                                                                                                                                                                                                                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text from allowlisted handle in 1:1   | Run normal AI pipeline                                                                                                                                                                                                                                                                                               |
| YES/NO reply when exactly 1 pending   | Pre-AI parser resolves the confirmation; no AI call                                                                                                                                                                                                                                                                  |
| Image attachment                      | Decoded base64 → GridFS → standard pipeline                                                                                                                                                                                                                                                                          |
| Voice attachment (audio/\*)           | Transcribed via STT (if `STT_PROVIDER` set) → `[voice] <transcript>`; otherwise `[voice note]` placeholder. Runs AI pipeline.                                                                                                                                                                                        |
| Document attachment (anything else)   | Inline `data` decoded — or fetched by GUID via `BlueBubblesClient.downloadAttachment` when not inlined (25 MB cap) — then saved to the workspace `inbox/` with a `[file saved to workspace: …]` marker. Fetch failure degrades to `[file … could not be retrieved]`; save failure to `[… couldn't save it: reason]`. |
| Group chat (`iMessage;+;…`)           | Ignored with debug log                                                                                                                                                                                                                                                                                               |
| Outgoing message (`isFromMe: true`)   | Ignored                                                                                                                                                                                                                                                                                                              |
| Reaction / tapback                    | Ignored                                                                                                                                                                                                                                                                                                              |
| Duplicate event (same `message.guid`) | Skipped (LRU dedupe, 200 entries)                                                                                                                                                                                                                                                                                    |
| Non-allowlisted handle                | Blocked + warning log                                                                                                                                                                                                                                                                                                |
| Rate limit (>15/min per handle)       | Dropped silently                                                                                                                                                                                                                                                                                                     |

## What's deferred

- **Group chats.** The webhook ignores `iMessage;+;…` chatGuids. Adding groups means deciding how Mashiro participates (mention-only? always?) and handling per-message handle vs. shared chatGuid.
- **Reactions / tapbacks.** Could be surfaced as conversation context (`[goshujin-sama liked your message]`) but adds noise without clear value.
- **Scheduler routing UI.** The dashboard treats reminders/routines/watchers as platform-agnostic — they work on either platform based on chatId prefix, but there's no UI surface to filter by platform yet.
