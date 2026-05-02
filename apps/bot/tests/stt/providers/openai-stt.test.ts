import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutable config fixture so each test can set STT_API_KEY / OPENAI_API_KEY /
// STT_BASE_URL independently. The fallback under test is the single line in
// openai-stt.ts that picks `apiKey` from STT_API_KEY || OPENAI_API_KEY — the
// `||` (not `??`) is load-bearing because `STT_API_KEY=` in a .env file
// produces "" not undefined, and `??` would not fall through.
const { mockConfig, mockCreateOpenAI, mockTranscribe } = vi.hoisted(() => ({
  mockConfig: {
    STT_API_KEY: undefined as string | undefined,
    OPENAI_API_KEY: undefined as string | undefined,
    STT_BASE_URL: undefined as string | undefined,
  },
  mockCreateOpenAI: vi.fn(() => ({ transcription: vi.fn() })),
  mockTranscribe: vi.fn(() => Promise.resolve({ text: "hi", durationInSeconds: 1.5 })),
}));

vi.mock("@mashiro/shared", () => ({
  config: mockConfig,
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock("@ai-sdk/openai", () => ({ createOpenAI: mockCreateOpenAI }));

vi.mock("ai", () => ({
  experimental_transcribe: mockTranscribe,
}));

import { transcribeWithOpenAi } from "../../../src/stt/providers/openai-stt";

beforeEach(() => {
  mockConfig.STT_API_KEY = undefined;
  mockConfig.OPENAI_API_KEY = undefined;
  mockConfig.STT_BASE_URL = undefined;
  mockCreateOpenAI.mockClear();
  mockTranscribe.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("transcribeWithOpenAi — apiKey fallback", () => {
  it("uses STT_API_KEY when set", async () => {
    mockConfig.STT_API_KEY = "stt-key";
    mockConfig.OPENAI_API_KEY = "openai-key";
    await transcribeWithOpenAi(Buffer.from("a"), "audio/ogg", "whisper-1");
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "stt-key" }),
    );
  });

  it("falls back to OPENAI_API_KEY when STT_API_KEY is unset", async () => {
    mockConfig.OPENAI_API_KEY = "openai-key";
    await transcribeWithOpenAi(Buffer.from("a"), "audio/ogg", "whisper-1");
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "openai-key" }),
    );
  });

  it('falls back to OPENAI_API_KEY when STT_API_KEY is "" (empty .env line)', async () => {
    // The shape `STT_API_KEY=` in a .env produces "" not undefined. The
    // `||` ensures empty string is treated like unset and falls through.
    // Using `??` here would hand "" to createOpenAI and fail at runtime
    // despite validateConfig passing.
    mockConfig.STT_API_KEY = "";
    mockConfig.OPENAI_API_KEY = "openai-key";
    await transcribeWithOpenAi(Buffer.from("a"), "audio/ogg", "whisper-1");
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "openai-key" }),
    );
  });

  it("forwards STT_BASE_URL when set, omits the field when unset", async () => {
    mockConfig.STT_API_KEY = "k";
    mockConfig.STT_BASE_URL = "http://127.0.0.1:8089/v1";
    await transcribeWithOpenAi(Buffer.from("a"), "audio/ogg", "whisper-1");
    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: "k",
      baseURL: "http://127.0.0.1:8089/v1",
    });

    mockCreateOpenAI.mockClear();
    mockConfig.STT_BASE_URL = undefined;
    await transcribeWithOpenAi(Buffer.from("a"), "audio/ogg", "whisper-1");
    expect(mockCreateOpenAI).toHaveBeenCalledWith({ apiKey: "k" });
  });

  it("returns text + durationSeconds from the SDK call", async () => {
    mockConfig.STT_API_KEY = "k";
    const result = await transcribeWithOpenAi(Buffer.from("a"), "audio/ogg", "whisper-1");
    expect(result).toEqual({ text: "hi", durationSeconds: 1.5 });
  });
});
