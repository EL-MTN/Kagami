import { Bot, InputFile } from "grammy";
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
}
