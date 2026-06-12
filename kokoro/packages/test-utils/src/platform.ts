import type { PlatformAdapter } from "@kokoro/shared";

export interface FakeAdapterCalls {
  sendText: Array<{ chatId: string; text: string }>;
  sendPhoto: Array<{
    chatId: string;
    photo: { path?: string; fileId?: string };
    caption?: string;
  }>;
  sendPhotoBuffer: Array<{ chatId: string; bytes: number; caption?: string }>;
  sendVoiceBuffer: Array<{ chatId: string; bytes: number; duration?: number }>;
  sendFileBuffer: Array<{
    chatId: string;
    bytes: number;
    fileName: string;
    mimeType?: string;
    caption?: string;
  }>;
  sendConfirmationPrompt: Array<{ chatId: string; text: string; confirmationId: string }>;
  editConfirmationPrompt: Array<{ chatId: string; messageId: string; text: string }>;
}

export interface FakeAdapter extends PlatformAdapter {
  calls: FakeAdapterCalls;
  /**
   * Reset all recorded calls — useful between phases of a single test.
   */
  reset(): void;
}

/**
 * Build a `PlatformAdapter` that records every method call rather than
 * dispatching anywhere. Each call appends to `adapter.calls.<method>`.
 *
 * `fakeMessageId` controls what `sendConfirmationPrompt` returns; defaults to
 * `"msg-1"`. `fakeFileId` controls what `sendPhoto` / `sendPhotoBuffer` returns.
 */
export function fakeAdapter(
  options: {
    platform?: string;
    fakeMessageId?: string;
    fakeFileId?: string;
  } = {},
): FakeAdapter {
  const platform = options.platform ?? "telegram";
  const fakeMessageId = options.fakeMessageId ?? "msg-1";
  const fakeFileId = options.fakeFileId ?? "file-1";

  const calls: FakeAdapterCalls = {
    sendText: [],
    sendPhoto: [],
    sendPhotoBuffer: [],
    sendVoiceBuffer: [],
    sendFileBuffer: [],
    sendConfirmationPrompt: [],
    editConfirmationPrompt: [],
  };

  return {
    platform,
    calls,
    reset() {
      calls.sendText.length = 0;
      calls.sendPhoto.length = 0;
      calls.sendPhotoBuffer.length = 0;
      calls.sendVoiceBuffer.length = 0;
      calls.sendFileBuffer.length = 0;
      calls.sendConfirmationPrompt.length = 0;
      calls.editConfirmationPrompt.length = 0;
    },
    sendText(chatId, text) {
      calls.sendText.push({ chatId, text });
      return Promise.resolve();
    },
    sendPhoto(chatId, photo, caption) {
      calls.sendPhoto.push({ chatId, photo, caption });
      return Promise.resolve(fakeFileId);
    },
    sendPhotoBuffer(chatId, buffer, caption) {
      calls.sendPhotoBuffer.push({ chatId, bytes: buffer.length, caption });
      return Promise.resolve(fakeFileId);
    },
    sendVoiceBuffer(chatId, buffer, duration) {
      calls.sendVoiceBuffer.push({ chatId, bytes: buffer.length, duration });
      return Promise.resolve();
    },
    sendFileBuffer(chatId, buffer, fileName, mimeType, caption) {
      calls.sendFileBuffer.push({ chatId, bytes: buffer.length, fileName, mimeType, caption });
      return Promise.resolve();
    },
    sendConfirmationPrompt(chatId, text, confirmationId) {
      calls.sendConfirmationPrompt.push({ chatId, text, confirmationId });
      return Promise.resolve(fakeMessageId);
    },
    editConfirmationPrompt(chatId, messageId, text) {
      calls.editConfirmationPrompt.push({ chatId, messageId, text });
      return Promise.resolve();
    },
  };
}
