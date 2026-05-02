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

const { mockGenerateImage, mockGenerateVoice } = vi.hoisted(() => ({
  mockGenerateImage: vi.fn(),
  mockGenerateVoice: vi.fn(),
}));
vi.mock("../../../src/context/generator", () => ({
  generateImage: mockGenerateImage,
}));
vi.mock("../../../src/tts/generator", () => ({
  generateVoice: mockGenerateVoice,
}));

import { createSendPhotoTool, createSendVoiceTool } from "../../../src/ai/tools/media";

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

beforeEach(() => {
  mockGenerateImage.mockReset();
  mockGenerateVoice.mockReset();
});

// ─── sendPhoto ───────────────────────────────────────────────────────────────

describe("sendPhoto tool", () => {
  it("generates the image with default 3:4 aspect ratio and sends it via the adapter", async () => {
    const buffer = Buffer.from("png-bytes");
    mockGenerateImage.mockResolvedValue({ buffer });
    const adapter = fakeAdapter();
    const tool = createSendPhotoTool("chat-1", adapter) as unknown as ExecutableTool;

    const result = await tool.execute({ description: "selfie at a coffee shop" });

    expect(result).toEqual({ sent: true, caption: undefined });
    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
    const args = mockGenerateImage.mock.calls[0]![0] as { aspectRatio: string; prompt: string };
    expect(args.aspectRatio).toBe("3:4");
    expect(args.prompt).toBe("selfie at a coffee shop");
    expect(adapter.calls.sendPhotoBuffer).toEqual([
      { chatId: "chat-1", bytes: buffer.length, caption: undefined },
    ]);
  });

  it("respects an explicit aspectRatio and forwards the caption to the adapter", async () => {
    mockGenerateImage.mockResolvedValue({ buffer: Buffer.from("x") });
    const adapter = fakeAdapter();
    const tool = createSendPhotoTool("chat-1", adapter) as unknown as ExecutableTool;

    await tool.execute({
      description: "park bench",
      caption: "afternoon walk",
      aspectRatio: "16:9",
    });

    const args = mockGenerateImage.mock.calls[0]![0] as { aspectRatio: string };
    expect(args.aspectRatio).toBe("16:9");
    expect(adapter.calls.sendPhotoBuffer[0]!.caption).toBe("afternoon walk");
  });

  it("returns sent:false when image generation fails — adapter is not invoked", async () => {
    mockGenerateImage.mockRejectedValue(new Error("image API 500"));
    const adapter = fakeAdapter();
    const tool = createSendPhotoTool("chat-1", adapter) as unknown as ExecutableTool;

    const result = await tool.execute({ description: "test" });

    expect(result).toEqual({ sent: false, reason: "image API 500" });
    expect(adapter.calls.sendPhotoBuffer).toEqual([]);
  });
});

// ─── sendVoice ───────────────────────────────────────────────────────────────

describe("sendVoice tool", () => {
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
