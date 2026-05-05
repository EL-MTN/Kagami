export interface IncomingMessage {
  platform: string;
  chatId: string;
  userId: string;
  userName: string;
  text: string;
  imageBase64?: string;
  imageMimeType?: string;
  /** Raw audio bytes for inbound voice notes / audio attachments. */
  audioBuffer?: Buffer;
  audioMimeType?: string;
  /**
   * Audio duration in integer seconds when known. Telegram surfaces this
   * directly on Voice/Audio; iMessage doesn't, so it may be undefined and
   * the STT API response duration will be used instead.
   */
  audioDurationSeconds?: number;
  timestamp: Date;
  replyToMessageId?: string;
  location?: {
    latitude: number;
    longitude: number;
    heading?: number;
    accuracy?: number;
    livePeriod?: number;
  };
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
  sendVoiceBuffer(chatId: string, buffer: Buffer, duration?: number): Promise<void>;
  /**
   * Send a message with [Approve][Deny] buttons attached. Returns the
   * platform-native message id so the caller can later edit the bubble in
   * place when the confirmation resolves. `confirmationId` is embedded in
   * the button callback payload so the platform's callback handler can
   * route the verdict back.
   */
  sendConfirmationPrompt(
    chatId: string,
    text: string,
    confirmationId: string,
  ): Promise<string | undefined>;
  /**
   * Edit a previously sent confirmation prompt to its terminal state. The
   * inline keyboard is removed; the body is replaced with `text`. Tolerant
   * of failures (the prompt may have been deleted by the user).
   */
  editConfirmationPrompt(chatId: string, messageId: string, text: string): Promise<void>;
}
