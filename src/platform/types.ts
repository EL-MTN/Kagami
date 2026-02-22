export interface IncomingMessage {
  platform: string;
  chatId: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: Date;
  replyToMessageId?: string;
}

export interface OutgoingMessage {
  text: string;
  photoPath?: string;
  photoFileId?: string;
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
