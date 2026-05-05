import { logger } from "@kokoro/shared";
import type { IncomingMessage, PlatformAdapter } from "@kokoro/shared";
import { BlueBubblesClient } from "./client";
import { imessageChatId } from "../registry";

/**
 * Adapter for BlueBubbles (self-hosted iMessage relay running on a Mac).
 *
 * Two semantic differences from the Telegram adapter that callers should
 * keep in mind:
 *
 * 1. iMessage has no inline buttons. `sendConfirmationPrompt` sends a
 *    plain text prompt asking the user to reply YES/NO; it returns
 *    `undefined` for the message id since editing isn't useful.
 * 2. iMessage has no third-party message edit. `editConfirmationPrompt`
 *    sends a new message instead of editing the prompt bubble.
 *
 * `chatId` values stored against this adapter use the namespaced
 * `imessage:` prefix (see `apps/bot/src/platform/registry.ts`). The
 * adapter strips the prefix when calling out to BlueBubbles since the
 * server uses the bare `chatGuid`.
 */
export class BlueBubblesAdapter implements PlatformAdapter {
  readonly platform = "imessage";

  constructor(private readonly client: BlueBubblesClient) {}

  /** chatId stored as "imessage:iMessage;-;+15551234567" → "iMessage;-;+15551234567" */
  private toChatGuid(chatId: string): string {
    return chatId.startsWith("imessage:") ? chatId.slice("imessage:".length) : chatId;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    await this.client.sendText({ chatGuid: this.toChatGuid(chatId), message: text });
  }

  sendPhoto(
    _chatId: string,
    _photo: { path?: string; fileId?: string },
    _caption?: string,
  ): Promise<string | undefined> {
    // The Telegram adapter accepts file paths or cached file_ids. iMessage
    // has no equivalent CDN cache, and the path-based send is unused
    // outside Telegram (image generation goes through sendPhotoBuffer).
    // Fail loudly if anyone reaches this path on iMessage so the bug is
    // obvious rather than silent.
    return Promise.reject(
      new Error("BlueBubblesAdapter.sendPhoto: use sendPhotoBuffer for iMessage"),
    );
  }

  async sendPhotoBuffer(
    chatId: string,
    buffer: Buffer,
    caption?: string,
  ): Promise<string | undefined> {
    await this.client.sendAttachment({
      chatGuid: this.toChatGuid(chatId),
      filename: "photo.jpg",
      buffer,
      mimeType: "image/jpeg",
    });
    if (caption) {
      // iMessage attachments don't carry captions; send caption as a
      // follow-up message so the user sees both bubbles in order.
      await this.client.sendText({ chatGuid: this.toChatGuid(chatId), message: caption });
    }
    return undefined;
  }

  async sendVoiceBuffer(chatId: string, buffer: Buffer): Promise<void> {
    // iMessage doesn't render M4A as a "voice note" the way native Voice
    // Memos do — it'll show up as a regular audio attachment. Acceptable
    // for v1; iMessage's first-party voice-note format requires a CAF
    // wrapper that BlueBubbles' send pipeline doesn't synthesize.
    await this.client.sendAttachment({
      chatGuid: this.toChatGuid(chatId),
      filename: "voice.m4a",
      buffer,
      mimeType: "audio/mp4",
    });
  }

  async sendConfirmationPrompt(
    chatId: string,
    text: string,
    _confirmationId: string,
  ): Promise<string | undefined> {
    // iMessage has no inline buttons. The webhook's pre-AI YES/NO parser
    // matches the user's reply against the most recent pending row in
    // this chat — no need to embed the id in the prompt.
    const body = `${text}\n\nReply YES to approve or NO to deny.`;
    await this.client.sendText({ chatGuid: this.toChatGuid(chatId), message: body });
    return undefined;
  }

  async editConfirmationPrompt(chatId: string, _messageId: string, text: string): Promise<void> {
    // No third-party edit on iMessage; send a new message with the
    // terminal-state line. The previous prompt bubble stays on screen
    // unchanged — that's the best we can do without first-party APIs.
    try {
      await this.client.sendText({ chatGuid: this.toChatGuid(chatId), message: text });
    } catch (error) {
      logger.warn(
        { err: error, chatId },
        "BlueBubbles editConfirmationPrompt fallback send failed",
      );
    }
  }
}

/**
 * Shape of the BlueBubbles `new-message` webhook event we care about.
 * The full payload is broader; we narrow to the fields the bot reads.
 */
export interface BlueBubblesMessageEvent {
  /** "new-message" is the only event the bot reacts to today. */
  type: string;
  data: {
    guid: string;
    text: string | null;
    chats: Array<{ guid: string; chatIdentifier?: string; participants?: unknown[] }>;
    handle?: { address: string } | null;
    isFromMe?: boolean;
    attachments?: Array<{
      guid: string;
      mimeType?: string | null;
      transferName?: string | null;
      data?: string | null;
    }>;
  };
}

export interface NormalizedWebhookEvent {
  message: IncomingMessage;
  /** raw chatGuid from BlueBubbles, used for sending replies back */
  chatGuid: string;
  /** message GUID, used for dedupe */
  messageGuid: string;
}

/**
 * Convert a BlueBubbles webhook payload into an `IncomingMessage`. Returns
 * null for events we ignore: outgoing messages, group chats (chatGuid not
 * starting with `iMessage;-;`), reactions, deletes, anything without text
 * or attachments.
 */
export function normalizeWebhookEvent(
  event: BlueBubblesMessageEvent,
): NormalizedWebhookEvent | null {
  if (event.type !== "new-message") return null;
  const data = event.data;
  if (!data || data.isFromMe) return null;
  if (!data.chats || data.chats.length === 0) return null;

  const chat = data.chats[0];
  const chatGuid = chat.guid;
  // v1 scope: 1:1 DMs only. Group chats (`iMessage;+;<guid>`) are deferred.
  if (!chatGuid.startsWith("iMessage;-;")) {
    logger.debug({ chatGuid }, "Ignoring non-DM iMessage chat");
    return null;
  }

  const handle = data.handle?.address;
  if (!handle) return null;

  const text = data.text ?? "";
  const attachment = data.attachments?.[0];

  let imageBase64: string | undefined;
  let imageMimeType: string | undefined;
  if (attachment && attachment.mimeType?.startsWith("image/")) {
    if (attachment.data) {
      imageBase64 = attachment.data;
      imageMimeType = attachment.mimeType ?? undefined;
    } else {
      // BlueBubbles can be configured to omit inline attachment data and
      // require a separate fetch by guid. We don't fetch here — the user
      // sees `[attachment]` and Mashiro responds without seeing the image.
      // Warn so the operator knows the BlueBubbles server isn't inlining.
      logger.warn(
        { attachmentGuid: attachment.guid, mimeType: attachment.mimeType },
        "iMessage image attachment had no inline data; image dropped",
      );
    }
  }

  // Voice notes / audio attachments. When BlueBubbles inlines `data`,
  // decode the base64 and route through the STT pipeline. iMessage's
  // attachment payload doesn't surface duration; the API response from
  // Whisper provides it after transcription. The 25 MB cap mirrors the
  // STT module's transcribeAudio cap — early reject so we don't write
  // a doomed buffer to GridFS.
  const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
  const isVoice = attachment && attachment.mimeType?.startsWith("audio/");
  let audioBuffer: Buffer | undefined;
  let audioMimeType: string | undefined;
  let voicePlaceholder = "[voice note]";
  if (isVoice) {
    if (attachment.data) {
      const buf = Buffer.from(attachment.data, "base64");
      if (buf.length <= MAX_AUDIO_BYTES) {
        audioBuffer = buf;
        audioMimeType = attachment.mimeType ?? "audio/mp4";
      } else {
        voicePlaceholder = "[voice note too long to transcribe]";
        logger.warn(
          { attachmentGuid: attachment.guid, bytes: buf.length },
          "iMessage voice attachment exceeded 25 MB cap; dropped",
        );
      }
    } else {
      logger.warn(
        { attachmentGuid: attachment.guid, mimeType: attachment.mimeType },
        "iMessage voice attachment had no inline data; voice dropped",
      );
    }
  }

  const effectiveText = isVoice ? voicePlaceholder : !text && attachment ? "[attachment]" : text;

  // `audioBuffer` is only ever set inside the `isVoice` branch above, and
  // that branch unconditionally sets `voicePlaceholder` as `effectiveText`.
  // So a truthy `audioBuffer` always implies truthy `effectiveText`, and the
  // null-return guard only needs to consider text + image presence.
  if (!effectiveText && !imageBase64) {
    return null;
  }

  const message: IncomingMessage = {
    platform: "imessage",
    chatId: imessageChatId(chatGuid),
    userId: handle,
    userName: handle,
    text: effectiveText,
    imageBase64,
    imageMimeType,
    audioBuffer,
    audioMimeType,
    timestamp: new Date(),
  };

  return { message, chatGuid, messageGuid: data.guid };
}
