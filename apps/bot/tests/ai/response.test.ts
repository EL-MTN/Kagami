import { describe, expect, it, vi } from "vitest";

// Silence the Pino logger so logSteps' debug calls don't leak into test output;
// also gives the logSteps test a spy to assert against.
vi.mock("@mashiro/shared", async (orig) => ({
  ...((await orig())),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

import { fakeAdapter } from "@mashiro/test-utils";
import { logger } from "@mashiro/shared";

import {
  collectToolCalls,
  extractResponseText,
  logSteps,
  sendSegmented,
  wasPhotoSent,
} from "../../src/ai/response";

/**
 * Build a minimal Step-shaped fixture. `StepResult<any>` from the AI SDK has
 * many fields the helpers don't read, so we cast through `unknown` and only
 * populate what the function actually accesses.
 */
function step(partial: {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults?: Array<{ toolCallId: string; toolName: string; output: unknown }>;
  finishReason?: string;
}): unknown {
  return partial;
}

// Cast helper so each call site stays terse.
function steps(...partials: ReturnType<typeof step>[]): Parameters<typeof extractResponseText>[0] {
  return partials as Parameters<typeof extractResponseText>[0];
}

describe("extractResponseText", () => {
  it("returns undefined for an empty step list", () => {
    expect(extractResponseText(steps())).toBeUndefined();
  });

  it("returns undefined when no step has text", () => {
    expect(extractResponseText(steps(step({ text: "" }), step({})))).toBeUndefined();
  });

  it("returns the text of the only step when a single step has text", () => {
    expect(extractResponseText(steps(step({ text: "hello" })))).toBe("hello");
  });

  it("walks backward and returns the last step with text", () => {
    expect(
      extractResponseText(
        steps(step({ text: "first" }), step({ text: "" }), step({ text: "last" })),
      ),
    ).toBe("last");
  });

  it("skips trailing empty-text steps and finds the most recent non-empty", () => {
    expect(
      extractResponseText(
        steps(step({ text: "early" }), step({ text: "middle" }), step({ text: "" })),
      ),
    ).toBe("middle");
  });
});

describe("collectToolCalls", () => {
  it("returns [] for an empty step list", () => {
    expect(collectToolCalls(steps())).toEqual([]);
  });

  it("flattens tool calls across steps and matches results by toolCallId", () => {
    const result = collectToolCalls(
      steps(
        step({
          toolCalls: [
            { toolCallId: "c1", toolName: "search", input: { q: "hi" } },
          ],
          toolResults: [{ toolCallId: "c1", toolName: "search", output: { hits: 3 } }],
        }),
        step({
          toolCalls: [{ toolCallId: "c2", toolName: "send", input: { to: "x" } }],
          toolResults: [
            { toolCallId: "c2", toolName: "send", output: { ok: true } },
          ],
        }),
      ),
    );
    expect(result).toEqual([
      { toolName: "search", args: { q: "hi" }, result: JSON.stringify({ hits: 3 }) },
      { toolName: "send", args: { to: "x" }, result: JSON.stringify({ ok: true }) },
    ]);
  });

  it("returns undefined for `result` when no matching tool result exists", () => {
    const result = collectToolCalls(
      steps(
        step({
          toolCalls: [{ toolCallId: "c1", toolName: "search", input: { q: "hi" } }],
          toolResults: [],
        }),
      ),
    );
    expect(result).toEqual([{ toolName: "search", args: { q: "hi" }, result: undefined }]);
  });

  it("matches results by id, not order", () => {
    const result = collectToolCalls(
      steps(
        step({
          toolCalls: [
            { toolCallId: "a", toolName: "x", input: {} },
            { toolCallId: "b", toolName: "y", input: {} },
          ],
          toolResults: [
            // b's result listed first
            { toolCallId: "b", toolName: "y", output: { v: "B" } },
            { toolCallId: "a", toolName: "x", output: { v: "A" } },
          ],
        }),
      ),
    );
    expect(result.map((r) => r.result)).toEqual([
      JSON.stringify({ v: "A" }),
      JSON.stringify({ v: "B" }),
    ]);
  });
});

describe("wasPhotoSent", () => {
  it("returns false when there are no tool results", () => {
    expect(wasPhotoSent(steps())).toBe(false);
  });

  it("returns true when the only tool was sendPhoto with sent: true", () => {
    expect(
      wasPhotoSent(
        steps(
          step({
            toolResults: [{ toolCallId: "c1", toolName: "sendPhoto", output: { sent: true } }],
          }),
        ),
      ),
    ).toBe(true);
  });

  it("returns false when sendPhoto returned sent: false", () => {
    expect(
      wasPhotoSent(
        steps(
          step({
            toolResults: [{ toolCallId: "c1", toolName: "sendPhoto", output: { sent: false } }],
          }),
        ),
      ),
    ).toBe(false);
  });

  it("returns true when only browse with sent: true (a screenshot) ran", () => {
    expect(
      wasPhotoSent(
        steps(
          step({
            toolResults: [{ toolCallId: "c1", toolName: "browse", output: { sent: true } }],
          }),
        ),
      ),
    ).toBe(true);
  });

  it("returns false when browse ran but didn't send a photo (regular browse step)", () => {
    expect(
      wasPhotoSent(
        steps(
          step({
            toolResults: [
              { toolCallId: "c1", toolName: "browse", output: { sent: false, text: "..." } },
            ],
          }),
        ),
      ),
    ).toBe(false);
  });

  it("returns false when sendPhoto ran alongside another non-photo tool (don't suppress text)", () => {
    expect(
      wasPhotoSent(
        steps(
          step({
            toolResults: [
              { toolCallId: "c1", toolName: "sendPhoto", output: { sent: true } },
              { toolCallId: "c2", toolName: "search", output: { hits: 0 } },
            ],
          }),
        ),
      ),
    ).toBe(false);
  });

  it("returns false when a non-sending browse step ran alongside sendPhoto", () => {
    // browse with sent:false counts as "another tool that did substantive
    // work" — its text response is meaningful, so don't suppress it just
    // because a separate sendPhoto bubble was also emitted.
    expect(
      wasPhotoSent(
        steps(
          step({
            toolResults: [
              { toolCallId: "c1", toolName: "sendPhoto", output: { sent: true } },
              { toolCallId: "c2", toolName: "browse", output: { sent: false } },
            ],
          }),
        ),
      ),
    ).toBe(false);
  });

  it("aggregates across steps", () => {
    expect(
      wasPhotoSent(
        steps(
          step({}),
          step({
            toolResults: [{ toolCallId: "c1", toolName: "sendPhoto", output: { sent: true } }],
          }),
          step({}),
        ),
      ),
    ).toBe(true);
  });
});

describe("sendSegmented", () => {
  it("splits on double-newline and sends each segment as a separate bubble", async () => {
    const adapter = fakeAdapter();
    await sendSegmented(adapter, "chat-1", "first paragraph\n\nsecond\n\nthird");
    expect(adapter.calls.sendText).toEqual([
      { chatId: "chat-1", text: "first paragraph" },
      { chatId: "chat-1", text: "second" },
      { chatId: "chat-1", text: "third" },
    ]);
  });

  it("preserves single newlines inside a segment", async () => {
    const adapter = fakeAdapter();
    await sendSegmented(adapter, "chat-1", "line one\nline two\n\nnext bubble");
    expect(adapter.calls.sendText).toEqual([
      { chatId: "chat-1", text: "line one\nline two" },
      { chatId: "chat-1", text: "next bubble" },
    ]);
  });

  it("filters out segments that are pure whitespace", async () => {
    const adapter = fakeAdapter();
    await sendSegmented(adapter, "chat-1", "first\n\n   \n\nsecond");
    expect(adapter.calls.sendText.map((c) => c.text)).toEqual(["first", "second"]);
  });

  it("does nothing for an empty or whitespace-only message", async () => {
    const adapter = fakeAdapter();
    await sendSegmented(adapter, "chat-1", "");
    await sendSegmented(adapter, "chat-1", "   \n\n   ");
    expect(adapter.calls.sendText).toEqual([]);
  });

  it("sends segments in order, awaiting each before the next", async () => {
    // Capture call order with timestamps to confirm sequential dispatch.
    const adapter = fakeAdapter();
    const order: string[] = [];
    adapter.sendText = (chatId: string, text: string) => {
      order.push(text);
      return Promise.resolve();
    };
    await sendSegmented(adapter, "chat-1", "a\n\nb\n\nc");
    expect(order).toEqual(["a", "b", "c"]);
  });
});

describe("logSteps", () => {
  it("emits one debug log per step", () => {
    const debugSpy = vi.mocked(logger.debug);
    debugSpy.mockClear();
    logSteps(steps(step({ text: "hi" }), step({}), step({ text: "bye" })));
    expect(debugSpy).toHaveBeenCalledTimes(3);
  });

  it("includes step index, text preview, tool counts, and finishReason in the log payload", () => {
    const debugSpy = vi.mocked(logger.debug);
    debugSpy.mockClear();
    logSteps(
      steps(
        step({
          text: "the quick brown fox jumps",
          toolCalls: [{ toolCallId: "c1", toolName: "search", input: {} }],
          finishReason: "tool-calls",
        }),
      ),
    );
    expect(debugSpy).toHaveBeenCalledTimes(1);
    const [payload, message] = debugSpy.mock.calls[0];
    expect(message).toBe("LLM step 0");
    expect(payload).toMatchObject({
      step: 0,
      hasText: true,
      textPreview: "the quick brown fox jumps",
      toolCallCount: 1,
      toolCalls: ["search"],
      finishReason: "tool-calls",
    });
  });

  it('renders an empty-text step as textPreview="(empty)" and hasText=false', () => {
    const debugSpy = vi.mocked(logger.debug);
    debugSpy.mockClear();
    logSteps(steps(step({})));
    const [payload] = debugSpy.mock.calls[0];
    expect(payload).toMatchObject({ hasText: false, textPreview: "(empty)" });
  });
});
