import { Bot, InputFile, InlineKeyboard } from "grammy";
import type { ActivityKind, IncomingMessage, PlatformAdapter } from "@kokoro/shared";
import type { Context } from "grammy";
import { logger } from "@kokoro/shared";
import { markdownToTelegramHtml } from "./format";

/**
 * grammY errors carry the full API request `payload` — for a confirmation
 * prompt that payload's `text` is the entire promptText, which for
 * executeCode is the program body itself. Logging or rethrowing the raw
 * error would ship that text to stdout/Kansoku, violating the never-log-code
 * policy (see gated-actions.ts). Redact in place — stack, error_code and
 * description all survive — BEFORE the error reaches any logger, here or in
 * a caller's catch.
 */
export function redactPromptPayload(error: unknown): void {
  if (error && typeof error === "object" && "payload" in error) {
    const payload = (error as { payload?: { text?: unknown } }).payload;
    if (payload && typeof payload.text === "string") {
      payload.text = `[redacted promptText, ${payload.text.length} chars]`;
    }
  }
}

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = "telegram";

  constructor(private bot: Bot) {}

  // ActivityKind is the honest subset of grammY's wider chat-action union
  // (no video/sticker/location verbs — Kokoro never sends those). Errors
  // propagate; the heartbeat in services/activity.ts is the fail-open layer.
  async sendActivity(chatId: string, kind: ActivityKind): Promise<void> {
    await this.bot.api.sendChatAction(chatId, kind);
  }

  normalize(ctx: Context): IncomingMessage | null {
    const msg = ctx.message;
    if (!msg || !msg.text || !msg.from) return null;

    return {
      platform: "telegram",
      chatId: String(msg.chat.id),
      userId: String(msg.from.id),
      userName: msg.from.first_name || "Unknown",
      text: msg.text,
      timestamp: new Date(msg.date * 1000),
      replyToMessageId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
    };
  }

  async normalizePhoto(ctx: Context): Promise<IncomingMessage | null> {
    const msg = ctx.message;
    if (!msg || !msg.photo?.length || !msg.from) return null;

    const largest = msg.photo[msg.photo.length - 1];

    try {
      const file = await ctx.api.getFile(largest.file_id);
      const res = await fetch(
        `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`,
      );
      if (!res.ok) {
        logger.error(
          { status: res.status, fileId: largest.file_id },
          "Failed to download photo from Telegram",
        );
        return null;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      const base64 = buffer.toString("base64");
      const mimeType = file.file_path?.endsWith(".png") ? "image/png" : "image/jpeg";

      return {
        platform: "telegram",
        chatId: String(msg.chat.id),
        userId: String(msg.from.id),
        userName: msg.from.first_name || "Unknown",
        text: msg.caption || "[photo]",
        imageBase64: base64,
        imageMimeType: mimeType,
        timestamp: new Date(msg.date * 1000),
        replyToMessageId: msg.reply_to_message
          ? String(msg.reply_to_message.message_id)
          : undefined,
      };
    } catch (error) {
      logger.error({ error: error, fileId: largest.file_id }, "Error downloading photo");
      return null;
    }
  }

  /**
   * Common shape for inbound voice/audio. Reads the file metadata, rejects
   * outright if the file size exceeds the 25 MB STT cap (so we don't bother
   * downloading a payload we can't transcribe), then downloads from
   * Telegram's CDN. Returns IncomingMessage with audio fields populated;
   * `handleMessage` does the GridFS write and STT call.
   */
  private async normalizeAudioFile(
    ctx: Context,
    fileId: string,
    mimeType: string | undefined,
    durationSeconds: number,
    fileSize: number | undefined,
    fallbackMime: string,
  ): Promise<IncomingMessage | null> {
    const msg = ctx.message;
    if (!msg || !msg.from) return null;
    const base = {
      platform: "telegram",
      chatId: String(msg.chat.id),
      userId: String(msg.from.id),
      userName: msg.from.first_name || "Unknown",
      timestamp: new Date(msg.date * 1000),
      replyToMessageId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
    };

    const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
    if (fileSize !== undefined && fileSize > MAX_AUDIO_BYTES) {
      logger.warn({ fileId, fileSize }, "Voice/audio exceeds 25 MB cap; skipping download");
      return {
        ...base,
        text: "[voice note too long to transcribe]",
        audioDurationSeconds: durationSeconds,
      };
    }

    try {
      const file = await ctx.api.getFile(fileId);
      const res = await fetch(
        `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`,
      );
      if (!res.ok) {
        logger.error({ status: res.status, fileId }, "Failed to download voice/audio");
        return null;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      // Telegram's `file_size` field is documented optional. When the
      // pre-download check above couldn't fire (size missing), re-check
      // after download so we never feed an oversized buffer downstream.
      if (buffer.length > MAX_AUDIO_BYTES) {
        logger.warn(
          { fileId, bytes: buffer.length },
          "Downloaded voice/audio exceeds 25 MB cap; dropping buffer",
        );
        return {
          ...base,
          text: "[voice note too long to transcribe]",
          audioDurationSeconds: durationSeconds,
        };
      }
      return {
        ...base,
        text: "[voice note]",
        audioBuffer: buffer,
        audioMimeType: mimeType ?? fallbackMime,
        audioDurationSeconds: durationSeconds,
      };
    } catch (error) {
      logger.error({ error: error, fileId }, "Error downloading voice/audio");
      return null;
    }
  }

  /** Telegram voice notes (recorded in-app). Always OGG/Opus, has duration. */
  async normalizeVoice(ctx: Context): Promise<IncomingMessage | null> {
    const voice = ctx.message?.voice;
    if (!voice) return null;
    return this.normalizeAudioFile(
      ctx,
      voice.file_id,
      voice.mime_type,
      voice.duration,
      voice.file_size,
      "audio/ogg",
    );
  }

  /** Telegram audio files (forwarded music or audio document). */
  async normalizeAudio(ctx: Context): Promise<IncomingMessage | null> {
    const audio = ctx.message?.audio;
    if (!audio) return null;
    return this.normalizeAudioFile(
      ctx,
      audio.file_id,
      audio.mime_type,
      audio.duration,
      audio.file_size,
      "audio/mpeg",
    );
  }

  /**
   * Telegram document attachments (generic files: PDFs, CSVs, archives, …).
   * Downloads from the CDN and hands the bytes to `handleMessage`, which owns
   * the workspace save (or the disabled-placeholder fallback). The 20 MB cap
   * is the Bot API's own `getFile` limit — files above it are physically
   * undownloadable by bots, so the user gets an honest marker instead of a
   * silent drop.
   */
  async normalizeDocument(ctx: Context): Promise<IncomingMessage | null> {
    const msg = ctx.message;
    const doc = msg?.document;
    if (!msg || !doc || !msg.from) return null;
    const base = {
      platform: "telegram",
      chatId: String(msg.chat.id),
      userId: String(msg.from.id),
      userName: msg.from.first_name || "Unknown",
      timestamp: new Date(msg.date * 1000),
      replyToMessageId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
    };

    const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
    const oversize = {
      ...base,
      text: `${msg.caption ? `${msg.caption}\n` : ""}[file "${doc.file_name ?? "unnamed"}" too large to receive — Telegram caps bot downloads at 20 MB]`,
    };
    if (doc.file_size !== undefined && doc.file_size > MAX_DOCUMENT_BYTES) {
      logger.warn(
        { fileId: doc.file_id, fileSize: doc.file_size },
        "Document exceeds Bot API 20 MB download cap; skipping download",
      );
      return oversize;
    }

    try {
      const file = await ctx.api.getFile(doc.file_id);
      const res = await fetch(
        `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`,
      );
      if (!res.ok) {
        logger.error({ status: res.status, fileId: doc.file_id }, "Failed to download document");
        return null;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      // `file_size` is documented optional — re-check after download.
      if (buffer.length > MAX_DOCUMENT_BYTES) {
        logger.warn(
          { fileId: doc.file_id, bytes: buffer.length },
          "Downloaded document exceeds 20 MB cap; dropping buffer",
        );
        return oversize;
      }
      return {
        ...base,
        text: msg.caption ?? "",
        documentBuffer: buffer,
        documentMimeType: doc.mime_type,
        documentFileName: doc.file_name,
      };
    } catch (error) {
      logger.error({ error: error, fileId: doc.file_id }, "Error downloading document");
      return null;
    }
  }

  normalizeLocation(ctx: Context): IncomingMessage | null {
    const msg = ctx.message;
    if (!msg?.location || !msg.from) return null;

    return {
      platform: "telegram",
      chatId: String(msg.chat.id),
      userId: String(msg.from.id),
      userName: msg.from.first_name || "Unknown",
      text: "[location shared]",
      timestamp: new Date(msg.date * 1000),
      location: {
        latitude: msg.location.latitude,
        longitude: msg.location.longitude,
        heading: msg.location.heading,
        accuracy: msg.location.horizontal_accuracy,
        livePeriod: msg.location.live_period,
      },
    };
  }

  normalizeLocationEdit(ctx: Context): IncomingMessage | null {
    const msg = ctx.editedMessage;
    if (!msg?.location || !msg.from) return null;

    return {
      platform: "telegram",
      chatId: String(msg.chat.id),
      userId: String(msg.from.id),
      userName: msg.from.first_name || "Unknown",
      text: "[live location update]",
      timestamp: new Date(msg.date * 1000),
      location: {
        latitude: msg.location.latitude,
        longitude: msg.location.longitude,
        heading: msg.location.heading,
        accuracy: msg.location.horizontal_accuracy,
        livePeriod: msg.location.live_period,
      },
    };
  }

  async sendText(chatId: string, text: string): Promise<void> {
    try {
      const html = markdownToTelegramHtml(text);
      await this.bot.api.sendMessage(Number(chatId), html, { parse_mode: "HTML" });
    } catch {
      // Fallback to plain text if HTML parsing fails
      await this.bot.api.sendMessage(Number(chatId), text);
    }
  }

  async sendPhoto(
    chatId: string,
    photo: { path?: string; fileId?: string },
    caption?: string,
  ): Promise<string | undefined> {
    const input = photo.fileId ? photo.fileId : new InputFile(photo.path!);

    const sent = await this.bot.api.sendPhoto(Number(chatId), input, {
      caption: caption ? markdownToTelegramHtml(caption) : undefined,
      parse_mode: "HTML",
    });

    const fileId = sent.photo?.at(-1)?.file_id;
    if (fileId) {
      logger.debug({ fileId }, "Cached telegram file_id");
    }
    return fileId;
  }

  async sendVoiceBuffer(chatId: string, buffer: Buffer, duration?: number): Promise<void> {
    const input = new InputFile(buffer, "voice.ogg");
    await this.bot.api.sendVoice(Number(chatId), input, duration ? { duration } : undefined);
  }

  async sendPhotoBuffer(
    chatId: string,
    buffer: Buffer,
    caption?: string,
  ): Promise<string | undefined> {
    const input = new InputFile(buffer, "mashiro.jpg");

    const sent = await this.bot.api.sendPhoto(Number(chatId), input, {
      caption: caption ? markdownToTelegramHtml(caption) : undefined,
      parse_mode: "HTML",
    });

    const fileId = sent.photo?.at(-1)?.file_id;
    if (fileId) {
      logger.debug({ fileId }, "Cached telegram file_id from buffer");
    }
    return fileId;
  }

  async sendFileBuffer(
    chatId: string,
    buffer: Buffer,
    fileName: string,
    _mimeType?: string,
    caption?: string,
  ): Promise<void> {
    // Telegram sniffs the content type itself; the InputFile name is what
    // the recipient sees and what determines the document's extension.
    const input = new InputFile(buffer, fileName);
    await this.bot.api.sendDocument(Number(chatId), input, {
      caption: caption ? markdownToTelegramHtml(caption) : undefined,
      parse_mode: "HTML",
    });
  }

  async sendConfirmationPrompt(
    chatId: string,
    text: string,
    confirmationId: string,
  ): Promise<string | undefined> {
    const keyboard = new InlineKeyboard()
      .text("✓ Approve", `confirm:${confirmationId}:approve`)
      .text("✗ Deny", `confirm:${confirmationId}:deny`);
    try {
      const sent = await this.bot.api.sendMessage(Number(chatId), markdownToTelegramHtml(text), {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      return String(sent.message_id);
    } catch (error) {
      redactPromptPayload(error);
      logger.warn({ error: error }, "Confirmation prompt HTML send failed; retrying as plain text");
      try {
        const sent = await this.bot.api.sendMessage(Number(chatId), text, {
          reply_markup: keyboard,
        });
        return String(sent.message_id);
      } catch (retryError) {
        // This error propagates to raisePendingConfirmation's caller, whose
        // catch logs it — it must leave here with the promptText scrubbed.
        redactPromptPayload(retryError);
        throw retryError;
      }
    }
  }

  async editConfirmationPrompt(chatId: string, messageId: string, text: string): Promise<void> {
    try {
      // editMessageText leaves reply_markup untouched unless we explicitly
      // pass it. Send an empty inline_keyboard so the [Approve][Deny]
      // buttons disappear once the row hits a terminal state — otherwise
      // the bubble body says "✓ Approved" but the buttons stay visible.
      await this.bot.api.editMessageText(Number(chatId), Number(messageId), text, {
        reply_markup: { inline_keyboard: [] },
      });
    } catch (error) {
      // Tolerable: user may have deleted the message, or the body is unchanged.
      logger.warn({ error: error, chatId, messageId }, "Failed to edit confirmation prompt");
    }
  }
}
