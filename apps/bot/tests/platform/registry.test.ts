import type { PlatformAdapter } from "@kokoro/shared";
import { describe, expect, it } from "vitest";

import { AdapterRegistry, imessageChatId, platformForChatId } from "../../src/platform/registry";

function stubAdapter(platform: string): PlatformAdapter {
  return {
    platform,
    sendText: () => Promise.resolve(),
    sendPhoto: () => Promise.resolve(undefined),
    sendPhotoBuffer: () => Promise.resolve(undefined),
    sendVoiceBuffer: () => Promise.resolve(),
    sendConfirmationPrompt: () => Promise.resolve(undefined),
    editConfirmationPrompt: () => Promise.resolve(),
  };
}

describe("platformForChatId", () => {
  it('returns "imessage" for ids carrying the imessage: prefix', () => {
    expect(platformForChatId("imessage:abc-def-123")).toBe("imessage");
  });

  it('returns "telegram" for bare numeric chat ids', () => {
    expect(platformForChatId("123456789")).toBe("telegram");
    expect(platformForChatId("-1001234567890")).toBe("telegram");
  });

  it('treats anything not starting with imessage: as telegram', () => {
    // Documenting current behavior: there are only two platforms today and the
    // registry assumes "not imessage" → "telegram". This is intentional per the
    // module-level comment.
    expect(platformForChatId("anything")).toBe("telegram");
    expect(platformForChatId("")).toBe("telegram");
  });

  it("is case-sensitive on the prefix", () => {
    // "Imessage:" with capital I is not the canonical prefix.
    expect(platformForChatId("Imessage:abc")).toBe("telegram");
  });
});

describe("imessageChatId", () => {
  it("prefixes the chatGuid with imessage:", () => {
    expect(imessageChatId("iMessage;-;chat123")).toBe("imessage:iMessage;-;chat123");
  });

  it("round-trips with platformForChatId", () => {
    const cid = imessageChatId("guid-xyz");
    expect(platformForChatId(cid)).toBe("imessage");
  });
});

describe("AdapterRegistry", () => {
  it("returns the registered adapter from get()", () => {
    const reg = new AdapterRegistry();
    const tg = stubAdapter("telegram");
    reg.register(tg);
    expect(reg.get("telegram")).toBe(tg);
  });

  it("returns undefined from get() for an unregistered platform", () => {
    const reg = new AdapterRegistry();
    expect(reg.get("imessage")).toBeUndefined();
  });

  it("has() reflects registration state", () => {
    const reg = new AdapterRegistry();
    expect(reg.has("telegram")).toBe(false);
    reg.register(stubAdapter("telegram"));
    expect(reg.has("telegram")).toBe(true);
  });

  it("require() throws for an unregistered platform", () => {
    const reg = new AdapterRegistry();
    expect(() => reg.require("imessage")).toThrowError(
      'No adapter registered for platform "imessage"',
    );
  });

  it("require() returns the adapter when registered", () => {
    const reg = new AdapterRegistry();
    const im = stubAdapter("imessage");
    reg.register(im);
    expect(reg.require("imessage")).toBe(im);
  });

  it("re-registering the same platform replaces the previous adapter", () => {
    const reg = new AdapterRegistry();
    const first = stubAdapter("telegram");
    const second = stubAdapter("telegram");
    reg.register(first);
    reg.register(second);
    expect(reg.get("telegram")).toBe(second);
    expect(reg.get("telegram")).not.toBe(first);
  });

  it("platforms() returns the registered platform names", () => {
    const reg = new AdapterRegistry();
    reg.register(stubAdapter("telegram"));
    reg.register(stubAdapter("imessage"));
    expect(reg.platforms().sort()).toEqual(["imessage", "telegram"]);
  });
});
