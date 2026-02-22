import type { TelegramAdapter } from "./adapter.js";

export function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

export async function sendPhotoWithCache(
  adapter: TelegramAdapter,
  chatId: string,
  photoPath: string,
  cachedFileId: string | undefined,
  caption?: string,
): Promise<string | undefined> {
  return adapter.sendPhoto(
    chatId,
    cachedFileId ? { fileId: cachedFileId } : { path: photoPath },
    caption,
  );
}
