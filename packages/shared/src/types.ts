export interface IncomingMessage {
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

export interface PlatformAdapter {
  readonly platform: string;
  sendText(chatId: string, text: string): Promise<void>;
  sendPhoto(
    chatId: string,
    photo: { path?: string; fileId?: string },
    caption?: string,
  ): Promise<string | undefined>; // returns file_id if available
  sendPhotoBuffer(chatId: string, buffer: Buffer, caption?: string): Promise<string | undefined>;
}

export interface VaultFile {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
}
