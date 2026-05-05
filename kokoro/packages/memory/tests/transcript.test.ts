import { describe, expect, it } from "vitest";
import type { IConversation } from "@kokoro/db";
import { buildTranscript, transcriptHasContent } from "../src/transcript";

function makeConvo(overrides: Partial<IConversation> = {}): IConversation {
  return {
    chatId: "c1",
    userId: "u1",
    platform: "telegram",
    sessionId: "session-abc",
    status: "closed",
    closedAt: new Date("2026-04-25T15:00:00Z"),
    messages: [],
    createdAt: new Date("2026-04-25T14:30:00Z"),
    updatedAt: new Date("2026-04-25T15:00:00Z"),
    ...overrides,
  } as unknown as IConversation;
}

describe("buildTranscript", () => {
  it("emits frontmatter with sessionId + ISO startedAt and numbered turn headings", () => {
    const convo = makeConvo({
      messages: [
        { role: "user", content: "hi", timestamp: new Date() },
        { role: "assistant", content: "hello", timestamp: new Date() },
      ],
    });
    const out = buildTranscript(convo);
    expect(out).toContain("id: session-abc");
    expect(out).toContain("started_at: 2026-04-25T14:30:00.000Z");
    expect(out).toContain("## t-1 user");
    expect(out).toContain("## t-2 assistant");
    expect(out.indexOf("## t-1")).toBeLessThan(out.indexOf("## t-2"));
  });

  it("skips system + tool messages — only user/assistant turns make it into the transcript", () => {
    const convo = makeConvo({
      messages: [
        { role: "system", content: "soul prompt", timestamp: new Date() },
        { role: "user", content: "hi", timestamp: new Date() },
        { role: "tool", content: "tool result", timestamp: new Date() },
        { role: "assistant", content: "hello", timestamp: new Date() },
      ],
    });
    const out = buildTranscript(convo);
    expect(out).not.toContain("soul prompt");
    expect(out).not.toContain("tool result");
    expect(out).toContain("## t-1 user");
    expect(out).toContain("## t-2 assistant");
    expect(out).not.toContain("## t-3");
  });

  it("skips empty / whitespace-only content so blank turns don't make it through", () => {
    const convo = makeConvo({
      messages: [
        { role: "user", content: "   ", timestamp: new Date() },
        { role: "user", content: "hi", timestamp: new Date() },
      ],
    });
    const out = buildTranscript(convo);
    expect(out).toContain("## t-1 user");
    expect(out).not.toContain("## t-2");
  });
});

describe("transcriptHasContent", () => {
  it("returns true when at least one user/assistant message has trimmed content", () => {
    const convo = makeConvo({
      messages: [
        { role: "system", content: "x", timestamp: new Date() },
        { role: "user", content: "hi", timestamp: new Date() },
      ],
    });
    expect(transcriptHasContent(convo)).toBe(true);
  });

  it("returns false when only system/tool messages are present", () => {
    const convo = makeConvo({
      messages: [
        { role: "system", content: "x", timestamp: new Date() },
        { role: "tool", content: "y", timestamp: new Date() },
      ],
    });
    expect(transcriptHasContent(convo)).toBe(false);
  });

  it("returns false on whitespace-only user/assistant content", () => {
    const convo = makeConvo({
      messages: [{ role: "user", content: "   ", timestamp: new Date() }],
    });
    expect(transcriptHasContent(convo)).toBe(false);
  });
});
