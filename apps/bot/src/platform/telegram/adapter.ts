import { Bot, InputFile, InlineKeyboard } from "grammy";
import type { IncomingMessage, PlatformAdapter } from "@mashiro/shared";
import type { Context } from "grammy";
import { logger } from "@mashiro/shared";
import { markdownToTelegramHtml } from "./format";

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = "telegram";

  constructor(private bot: Bot) {}

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
      logger.error({ error, fileId: largest.file_id }, "Error downloading photo");
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
      logger.error({ error, fileId }, "Error downloading voice/audio");
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
      logger.warn({ error }, "Confirmation prompt HTML send failed; retrying as plain text");
      const sent = await this.bot.api.sendMessage(Number(chatId), text, {
        reply_markup: keyboard,
      });
      return String(sent.message_id);
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
      logger.warn({ error, chatId, messageId }, "Failed to edit confirmation prompt");
    }
  }
}
