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

const { mockGenerateImage } = vi.hoisted(() => ({ mockGenerateImage: vi.fn() }));
vi.mock("../../../src/context/generator", () => ({
  generateImage: mockGenerateImage,
}));

import { createSendPhotoTool } from "../../../src/ai/tools/send-photo";

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

describe("sendPhoto tool", () => {
  beforeEach(() => {
    mockGenerateImage.mockReset();
  });

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
    expect(args.prompt).toContain("Scene: selfie at a coffee shop");
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
