import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted lets us share mutable test fixtures with vi.mock factories,
// which run before module imports.
const { mockConfig, mockTranscribeWithOpenAi, mockTrackStt } = vi.hoisted(() => ({
  mockConfig: { STT_PROVIDER: undefined as string | undefined },
  mockTranscribeWithOpenAi: vi.fn(),
  mockTrackStt: vi.fn(),
}));

vi.mock("@kokoro/shared", () => ({
  config: mockConfig,
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock("../../src/stt/providers/openai-stt", () => ({
  transcribeWithOpenAi: mockTranscribeWithOpenAi,
}));

vi.mock("../../src/ai/token-tracker", () => ({
  trackSttTranscription: mockTrackStt,
}));

import { transcribeAudio } from "../../src/stt/transcriber";

beforeEach(() => {
  mockConfig.STT_PROVIDER = "openai/whisper-1";
  mockTranscribeWithOpenAi.mockReset();
  mockTrackStt.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("transcribeAudio — gating", () => {
  it('returns { ok: false, reason: "disabled" } when STT_PROVIDER is unset', async () => {
    mockConfig.STT_PROVIDER = undefined;
    const result = await transcribeAudio({ audio: Buffer.from("hi"), mimeType: "audio/ogg" });
    expect(result).toEqual({ ok: false, reason: "disabled" });
    expect(mockTranscribeWithOpenAi).not.toHaveBeenCalled();
  });

  it('returns "disabled" when STT_PROVIDER is the empty string (falsy)', async () => {
    mockConfig.STT_PROVIDER = "";
    const result = await transcribeAudio({ audio: Buffer.from("hi"), mimeType: "audio/ogg" });
    expect(result).toEqual({ ok: false, reason: "disabled" });
  });
});

describe("transcribeAudio — caps", () => {
  it('returns "too-large" when audio exceeds 25 MB byte cap', async () => {
    // One byte over the 25 MB cap.
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1);
    const result = await transcribeAudio({ audio: oversized, mimeType: "audio/ogg" });
    expect(result).toEqual({ ok: false, reason: "too-large" });
    expect(mockTranscribeWithOpenAi).not.toHaveBeenCalled();
  });

  it("accepts audio at exactly the byte cap", async () => {
    mockTranscribeWithOpenAi.mockResolvedValue({ text: "ok", durationSeconds: 1 });
    const atCap = Buffer.alloc(25 * 1024 * 1024);
    const result = await transcribeAudio({ audio: atCap, mimeType: "audio/ogg" });
    expect(result.ok).toBe(true);
  });

  it('returns "too-large" when durationSeconds exceeds the 1800 s cap', async () => {
    const result = await transcribeAudio({
      audio: Buffer.from("hi"),
      mimeType: "audio/ogg",
      durationSeconds: 1801,
    });
    expect(result).toEqual({ ok: false, reason: "too-large" });
  });

  it("accepts audio at exactly the duration cap", async () => {
    mockTranscribeWithOpenAi.mockResolvedValue({ text: "ok" });
    const result = await transcribeAudio({
      audio: Buffer.from("hi"),
      mimeType: "audio/ogg",
      durationSeconds: 1800,
    });
    expect(result.ok).toBe(true);
  });

  it("ignores duration check when durationSeconds is undefined", async () => {
    mockTranscribeWithOpenAi.mockResolvedValue({ text: "ok" });
    const result = await transcribeAudio({
      audio: Buffer.from("hi"),
      mimeType: "audio/ogg",
    });
    expect(result.ok).toBe(true);
  });
});

describe("transcribeAudio — happy path", () => {
  it("returns the transcribed text and prefers API-reported duration", async () => {
    mockTranscribeWithOpenAi.mockResolvedValue({ text: "hello world", durationSeconds: 2.5 });
    const result = await transcribeAudio({
      audio: Buffer.from("hi"),
      mimeType: "audio/ogg",
      durationSeconds: 99, // platform hint — should be overridden by API value
    });
    expect(result).toEqual({ ok: true, text: "hello world", durationSeconds: 2.5 });
    expect(mockTrackStt).toHaveBeenCalledWith("whisper-1", "openai", 2.5);
  });

  it("falls back to the request's duration hint when API doesn't return one", async () => {
    mockTranscribeWithOpenAi.mockResolvedValue({ text: "hi" });
    const result = await transcribeAudio({
      audio: Buffer.from("hi"),
      mimeType: "audio/ogg",
      durationSeconds: 7,
    });
    expect(result).toEqual({ ok: true, text: "hi", durationSeconds: 7 });
    expect(mockTrackStt).toHaveBeenCalledWith("whisper-1", "openai", 7);
  });

  it("forwards the parsed modelId to the openai provider", async () => {
    mockConfig.STT_PROVIDER = "openai/whisper-large-v3";
    mockTranscribeWithOpenAi.mockResolvedValue({ text: "x" });
    const audio = Buffer.from("hi");
    await transcribeAudio({ audio, mimeType: "audio/m4a" });
    expect(mockTranscribeWithOpenAi).toHaveBeenCalledWith(audio, "audio/m4a", "whisper-large-v3");
  });
});

describe("transcribeAudio — failure handling", () => {
  it('returns { ok: false, reason: "failed" } when the underlying provider throws', async () => {
    mockTranscribeWithOpenAi.mockRejectedValue(new Error("whisper 500"));
    const result = await transcribeAudio({ audio: Buffer.from("hi"), mimeType: "audio/ogg" });
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(mockTrackStt).not.toHaveBeenCalled();
  });

  it('returns "failed" when STT_PROVIDER references an unsupported provider', async () => {
    mockConfig.STT_PROVIDER = "deepgram/nova-2";
    const result = await transcribeAudio({ audio: Buffer.from("hi"), mimeType: "audio/ogg" });
    expect(result).toEqual({ ok: false, reason: "failed" });
  });

  it('returns "failed" when STT_PROVIDER is missing the provider/model slash', async () => {
    // The function's contract is non-throwing: any provider-spec or transport
    // error must surface as { ok: false, reason: "failed" }. Pinned so a
    // refactor that moves parseProviderSpec back outside the try/catch
    // would fail this test.
    mockConfig.STT_PROVIDER = "openai";
    const result = await transcribeAudio({ audio: Buffer.from("hi"), mimeType: "audio/ogg" });
    expect(result).toEqual({ ok: false, reason: "failed" });
  });
});
