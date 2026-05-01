import { fakeAdapter } from "@mashiro/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mashiro/shared", async (orig) => ({
  ...((await orig()) as object),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

const { mockGenerateVoice } = vi.hoisted(() => ({ mockGenerateVoice: vi.fn() }));
vi.mock("../../../src/tts/generator", () => ({
  generateVoice: mockGenerateVoice,
}));

import { createSendVoiceTool } from "../../../src/ai/tools/send-voice";

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

describe("sendVoice tool", () => {
  beforeEach(() => {
    mockGenerateVoice.mockReset();
  });

  it("generates audio and sends it via the adapter with duration", async () => {
    const buffer = Buffer.from("ogg-bytes");
    mockGenerateVoice.mockResolvedValue({ buffer, durationSeconds: 4 });
    const adapter = fakeAdapter();
    const tool = createSendVoiceTool("chat-1", adapter) as unknown as ExecutableTool;

    const result = await tool.execute({ text: "hello there" });

    expect(result).toEqual({ sent: true });
    expect(mockGenerateVoice).toHaveBeenCalledWith({ text: "hello there" });
    expect(adapter.calls.sendVoiceBuffer).toEqual([
      { chatId: "chat-1", bytes: buffer.length, duration: 4 },
    ]);
  });

  it("returns sent:false on TTS failure and skips the adapter call", async () => {
    mockGenerateVoice.mockRejectedValue(new Error("tts 500"));
    const adapter = fakeAdapter();
    const tool = createSendVoiceTool("chat-1", adapter) as unknown as ExecutableTool;

    const result = await tool.execute({ text: "anything" });

    expect(result).toEqual({ sent: false, reason: "Voice generation failed" });
    expect(adapter.calls.sendVoiceBuffer).toEqual([]);
  });
});
