import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "grammy";

vi.mock("@kokoro/shared", async (orig) => ({
  ...(await orig<typeof import("@kokoro/shared")>()),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

import { logger } from "@kokoro/shared";
import { TelegramAdapter, redactPromptPayload } from "../../../src/platform/telegram/adapter";

/** executeCode-style prompt: the text IS the program the user reviews. */
const CODE_PROMPT = 'Run this python code?\n\n```python\nsecret_program("token")\n```';

/**
 * grammY-style send failure: the full API request payload (including `text`)
 * rides on the error object — exactly what must never reach a logger when the
 * text is an executeCode program.
 */
function grammySendError(text: string) {
  return Object.assign(new Error("Call to 'sendMessage' failed! (400: Bad Request)"), {
    payload: { chat_id: 1, text, parse_mode: "HTML" },
  });
}

function makeAdapter(sendMessage: ReturnType<typeof vi.fn>) {
  return new TelegramAdapter({ api: { sendMessage } } as unknown as Bot);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendConfirmationPrompt — never-log-code redaction", () => {
  it("redacts the prompt text from the logged error when the HTML send fails", async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(grammySendError("<converted html> secret_program"))
      .mockResolvedValueOnce({ message_id: 77 });

    const id = await makeAdapter(sendMessage).sendConfirmationPrompt("1", CODE_PROMPT, "conf-1");

    expect(id).toBe("77");
    const [logged] = vi.mocked(logger.warn).mock.calls[0] as unknown as [
      { error: { payload: { text: string } } },
    ];
    expect(logged.error.payload.text).not.toContain("secret_program");
    expect(logged.error.payload.text).toMatch(/^\[redacted promptText, \d+ chars\]$/);
  });

  it("rethrows with the prompt text scrubbed when the plain retry also fails", async () => {
    // This error propagates up through raisePendingConfirmation to the
    // tool's catch, which logs it — it must leave the adapter pre-scrubbed.
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(grammySendError("<converted html> secret_program"))
      .mockRejectedValueOnce(grammySendError(CODE_PROMPT));

    const thrown = (await makeAdapter(sendMessage)
      .sendConfirmationPrompt("1", CODE_PROMPT, "conf-1")
      .catch((e: unknown) => e)) as Error & { payload: { text: string; chat_id: number } };

    // Diagnostics survive — only the message body is gone.
    expect(thrown.message).toContain("sendMessage");
    expect(thrown.payload.chat_id).toBe(1);
    expect(thrown.payload.text).not.toContain("secret_program");
    expect(thrown.payload.text).toMatch(/^\[redacted promptText, \d+ chars\]$/);
  });
});

describe("redactPromptPayload", () => {
  it("leaves errors without a string payload.text untouched", () => {
    const plain = new Error("boom");
    redactPromptPayload(plain);
    expect(plain.message).toBe("boom");

    const odd = Object.assign(new Error("x"), { payload: { text: 42 } });
    redactPromptPayload(odd);
    expect(odd.payload.text).toBe(42);
  });
});
