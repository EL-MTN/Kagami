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
   * Raw bytes of an inbound document attachment (anything that isn't an
   * image or audio: PDFs, CSVs, archives, …). The message handler saves it
   * to the persistent workspace under inbox/.
   */
  documentBuffer?: Buffer;
  documentMimeType?: string;
  /** Original filename of the document attachment, when the platform provides one. */
  documentFileName?: string;
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

/**
 * Ephemeral "what is the bot doing" verbs, rendered by platforms that
 * support them (Telegram chat actions: "typing…", "sending a photo…",
 * "recording a voice message…"). Deliberately a subset of Telegram's union —
 * only verbs Kokoro can honestly promise are included; the verb is a promise
 * about what the user is about to receive.
 */
export type ActivityKind =
  | "typing"
  | "upload_photo"
  | "record_voice"
  | "upload_voice"
  | "upload_document";

export interface PlatformAdapter {
  readonly platform: string;
  /**
   * Paint an ephemeral activity indicator in the chat (no message, no
   * notification, self-expires in ~5s — callers re-emit to sustain it).
   * Optional capability: platforms without an equivalent (iMessage via
   * BlueBubbles today) simply omit it and callers degrade to silence.
   */
  sendActivity?(chatId: string, kind: ActivityKind): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
  sendPhoto(
    chatId: string,
    photo: { path?: string; fileId?: string },
    caption?: string,
  ): Promise<string | undefined>; // returns file_id if available
  sendPhotoBuffer(chatId: string, buffer: Buffer, caption?: string): Promise<string | undefined>;
  sendVoiceBuffer(chatId: string, buffer: Buffer, duration?: number): Promise<void>;
  /**
   * Send an arbitrary file as a document attachment. `fileName` is the
   * display name the recipient sees; `mimeType` is a hint for platforms
   * that carry one (BlueBubbles), ignored where the platform sniffs for
   * itself (Telegram).
   */
  sendFileBuffer(
    chatId: string,
    buffer: Buffer,
    fileName: string,
    mimeType?: string,
    caption?: string,
  ): Promise<void>;
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
