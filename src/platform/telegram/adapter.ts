import { Bot, InputFile } from "grammy";
import type { PlatformAdapter, IncomingMessage } from "../types.js";
import type { Context } from "grammy";
import { logger } from "../../utils/logger.js";

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = "telegram";

  constructor(private bot: Bot) {}

  normalize(ctx: Context): IncomingMessage | null {
    const msg = ctx.message;
    if (!msg || !msg.text) return null;

    return {
      platform: "telegram",
      chatId: String(msg.chat.id),
      userId: String(msg.from.id),
      userName: msg.from.first_name || "Unknown",
      text: msg.text,
      timestamp: new Date(msg.date * 1000),
      replyToMessageId: msg.reply_to_message
        ? String(msg.reply_to_message.message_id)
        : undefined,
    };
  }

  async sendText(chatId: string, text: string): Promise<void> {
    await this.bot.api.sendMessage(Number(chatId), text, {
      parse_mode: "Markdown",
    });
  }

  async sendPhoto(
    chatId: string,
    photo: { path?: string; fileId?: string },
    caption?: string,
  ): Promise<string | undefined> {
    const input = photo.fileId
      ? photo.fileId
      : new InputFile(photo.path!);

    const sent = await this.bot.api.sendPhoto(Number(chatId), input, {
      caption,
      parse_mode: "Markdown",
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
    const input = new InputFile(buffer, "luna.jpg");

    const sent = await this.bot.api.sendPhoto(Number(chatId), input, {
      caption,
      parse_mode: "Markdown",
    });

    const fileId = sent.photo?.at(-1)?.file_id;
    if (fileId) {
      logger.debug({ fileId }, "Cached telegram file_id from buffer");
    }
    return fileId;
  }
}
