import { withTestDb } from "@kokoro/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Conversation,
  appendMessage,
  cleanupOldConversations,
  clearConversation,
  closeSession,
  getOrCreateSession,
  getOverflowMessages,
  getRecentMessages,
  trimConversation,
  type IMessage,
} from "../../src/models/conversation";

// Stub the GridFS removers so the conversation tests don't need a live
// bucket. Bucket isolation is covered separately in gridfs.test.ts.
vi.mock("../../src/gridfs", () => ({
  removeImages: vi.fn(() => Promise.resolve()),
  removeAudios: vi.fn(() => Promise.resolve()),
}));

import { removeAudios, removeImages } from "../../src/gridfs";

withTestDb({ syncIndexes: false });

beforeEach(() => {
  vi.mocked(removeImages).mockClear();
  vi.mocked(removeAudios).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

const userMessage = (content: string, timestamp = new Date()): IMessage => ({
  role: "user",
  content,
  timestamp,
});

describe("getOrCreateSession", () => {
  it("creates a fresh active session when none exists", async () => {
    const { conversation, previouslyClosed } = await getOrCreateSession(
      "chat-1",
      "user-1",
      "telegram",
    );
    expect(conversation.chatId).toBe("chat-1");
    expect(conversation.platform).toBe("telegram");
    expect(conversation.status).toBe("active");
    expect(conversation.sessionId).toBeTruthy();
    expect(conversation.messages).toEqual([]);
    expect(previouslyClosed).toBeUndefined();
  });

  it("returns the existing active session when within the idle threshold", async () => {
    const first = await getOrCreateSession("chat-1", "user-1", "telegram");
    const second = await getOrCreateSession("chat-1", "user-1", "telegram");
    expect(second.conversation.id).toBe(first.conversation.id);
    expect(second.previouslyClosed).toBeUndefined();
  });

  it("scopes by platform — same chatId on Telegram and iMessage are independent sessions", async () => {
    // This is the load-bearing invariant: a Telegram session must never be
    // returned for an iMessage lookup with the same numeric-looking chatId,
    // and vice versa. The platform argument participates in the lookup.
    const tg = await getOrCreateSession("12345", "user-1", "telegram");
    const im = await getOrCreateSession("12345", "user-1", "imessage");
    expect(im.conversation.id).not.toBe(tg.conversation.id);
    expect(tg.conversation.platform).toBe("telegram");
    expect(im.conversation.platform).toBe("imessage");

    // Re-fetching each platform must still return its own session.
    const tg2 = await getOrCreateSession("12345", "user-1", "telegram");
    const im2 = await getOrCreateSession("12345", "user-1", "imessage");
    expect(tg2.conversation.id).toBe(tg.conversation.id);
    expect(im2.conversation.id).toBe(im.conversation.id);
  });

  it("closes the stale session and starts a new one past the 1 h idle threshold", async () => {
    const first = await getOrCreateSession("chat-1", "user-1", "telegram");
    // Backdate updatedAt to 2 hours ago. Saving via .save() would refresh the
    // timestamp, so we update directly through the collection.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await Conversation.collection.updateOne(
      { _id: first.conversation._id },
      { $set: { updatedAt: twoHoursAgo } },
    );

    const second = await getOrCreateSession("chat-1", "user-1", "telegram");
    expect(second.conversation.id).not.toBe(first.conversation.id);
    expect(second.previouslyClosed?.id).toBe(first.conversation.id);
    expect(second.previouslyClosed?.status).toBe("closed");

    // The old session should be persisted as closed.
    const reloaded = await Conversation.findById(first.conversation._id);
    expect(reloaded?.status).toBe("closed");
    expect(reloaded?.closedAt).toBeInstanceOf(Date);
  });

  it("returns the most recent active session when multiple are present", async () => {
    // Defensive: there should normally be only one active session per
    // (chatId, platform), but if duplicates exist we sort by updatedAt desc.
    const older = await Conversation.create({
      chatId: "chat-1",
      userId: "user-1",
      platform: "telegram",
      status: "active",
      sessionId: "older",
      messages: [],
    });
    await Conversation.collection.updateOne(
      { _id: older._id },
      { $set: { updatedAt: new Date(Date.now() - 30 * 60 * 1000) } },
    );
    const newer = await Conversation.create({
      chatId: "chat-1",
      userId: "user-1",
      platform: "telegram",
      status: "active",
      sessionId: "newer",
      messages: [],
    });

    const result = await getOrCreateSession("chat-1", "user-1", "telegram");
    expect(result.conversation.id).toBe(newer.id);
  });
});

describe("appendMessage", () => {
  it("appends a message and refreshes updatedAt", async () => {
    const { conversation } = await getOrCreateSession("chat-1", "user-1", "telegram");
    const beforeUpdated = conversation.updatedAt.getTime();
    // Force a tick.
    await new Promise((r) => setTimeout(r, 5));
    await appendMessage(conversation, userMessage("hello"));
    const reloaded = await Conversation.findById(conversation._id);
    expect(reloaded?.messages).toHaveLength(1);
    expect(reloaded?.messages[0]!.content).toBe("hello");
    expect(reloaded!.updatedAt.getTime()).toBeGreaterThan(beforeUpdated);
  });
});

describe("closeSession", () => {
  it("flips status to closed and stamps closedAt", async () => {
    const { conversation } = await getOrCreateSession("chat-1", "user-1", "telegram");
    await closeSession(conversation);
    const reloaded = await Conversation.findById(conversation._id);
    expect(reloaded?.status).toBe("closed");
    expect(reloaded?.closedAt).toBeInstanceOf(Date);
  });
});

describe("getRecentMessages", () => {
  it("returns the last `limit` messages from the active session", async () => {
    const { conversation } = await getOrCreateSession("chat-1", "user-1", "telegram");
    for (let i = 0; i < 10; i++) {
      await appendMessage(conversation, userMessage(`msg-${String(i)}`));
    }
    const last3 = await getRecentMessages("chat-1", 3);
    expect(last3.map((m) => m.content)).toEqual(["msg-7", "msg-8", "msg-9"]);
  });

  it("returns [] when there's no active session", async () => {
    expect(await getRecentMessages("missing")).toEqual([]);
  });

  it("defaults the limit to 40", async () => {
    const { conversation } = await getOrCreateSession("chat-1", "user-1", "telegram");
    for (let i = 0; i < 50; i++) {
      await appendMessage(conversation, userMessage(`m${String(i)}`));
    }
    const recent = await getRecentMessages("chat-1");
    expect(recent).toHaveLength(40);
    expect(recent[0].content).toBe("m10");
    expect(recent[39].content).toBe("m49");
  });
});

describe("getOverflowMessages", () => {
  it("returns null when there's no active session", async () => {
    expect(await getOverflowMessages("missing")).toBeNull();
  });

  it("returns null when the session has fewer messages than the context limit", async () => {
    const { conversation } = await getOrCreateSession("chat-1", "user-1", "telegram");
    await appendMessage(conversation, userMessage("hi"));
    expect(await getOverflowMessages("chat-1", 40)).toBeNull();
  });

  it("returns the oldest messages beyond the context limit", async () => {
    const { conversation } = await getOrCreateSession("chat-1", "user-1", "telegram");
    for (let i = 0; i < 5; i++) {
      await appendMessage(conversation, userMessage(`m${String(i)}`));
    }
    const result = await getOverflowMessages("chat-1", 3);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(5);
    expect(result!.overflow.map((m) => m.content)).toEqual(["m0", "m1"]);
  });
});

describe("clearConversation", () => {
  it("deletes active conversations and removes referenced GridFS keys", async () => {
    const { conversation } = await getOrCreateSession("chat-1", "user-1", "telegram");
    await appendMessage(conversation, {
      role: "user",
      content: "look at this",
      imageRef: "img-1",
      timestamp: new Date(),
    });
    await appendMessage(conversation, {
      role: "user",
      content: "and this",
      audioRef: "aud-1",
      timestamp: new Date(),
    });

    await clearConversation("chat-1");

    expect(vi.mocked(removeImages)).toHaveBeenCalledWith(["img-1"]);
    expect(vi.mocked(removeAudios)).toHaveBeenCalledWith(["aud-1"]);
    expect(await Conversation.findById(conversation._id)).toBeNull();
  });

  it("leaves closed conversations alone", async () => {
    const { conversation } = await getOrCreateSession("chat-1", "user-1", "telegram");
    await closeSession(conversation);
    await clearConversation("chat-1");
    const reloaded = await Conversation.findById(conversation._id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.status).toBe("closed");
  });
});

describe("trimConversation", () => {
  it("removes the oldest messages and frees their GridFS refs", async () => {
    const { conversation } = await getOrCreateSession("chat-1", "user-1", "telegram");
    for (let i = 0; i < 5; i++) {
      await appendMessage(conversation, {
        role: "user",
        content: `m${String(i)}`,
        imageRef: `img-${String(i)}`,
        timestamp: new Date(),
      });
    }
    await trimConversation(conversation._id.toString(), 2);

    const reloaded = await Conversation.findById(conversation._id);
    expect(reloaded?.messages.map((m) => m.content)).toEqual(["m3", "m4"]);
    // Trimmed messages were m0..m2 — their image refs should be removed.
    expect(vi.mocked(removeImages)).toHaveBeenCalledWith(["img-0", "img-1", "img-2"]);
  });

  it("is a no-op when message count is at or below the keep limit", async () => {
    const { conversation } = await getOrCreateSession("chat-1", "user-1", "telegram");
    await appendMessage(conversation, userMessage("only"));
    await trimConversation(conversation._id.toString(), 2);
    const reloaded = await Conversation.findById(conversation._id);
    expect(reloaded?.messages).toHaveLength(1);
    expect(vi.mocked(removeImages)).not.toHaveBeenCalled();
  });

  it("returns silently for a non-existent conversation id", async () => {
    await expect(trimConversation("000000000000000000000000", 10)).resolves.toBeUndefined();
  });
});

describe("cleanupOldConversations", () => {
  it("deletes closed conversations older than the cutoff and reports the count", async () => {
    const old = await Conversation.create({
      chatId: "chat-1",
      userId: "user-1",
      platform: "telegram",
      status: "closed",
      closedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
      sessionId: "old",
      messages: [],
    });
    const recent = await Conversation.create({
      chatId: "chat-1",
      userId: "user-1",
      platform: "telegram",
      status: "closed",
      closedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      sessionId: "recent",
      messages: [],
    });
    const active = await Conversation.create({
      chatId: "chat-1",
      userId: "user-1",
      platform: "telegram",
      status: "active",
      sessionId: "active",
      messages: [],
    });

    const removed = await cleanupOldConversations(90);
    expect(removed).toBe(1);
    expect(await Conversation.findById(old._id)).toBeNull();
    expect(await Conversation.findById(recent._id)).not.toBeNull();
    expect(await Conversation.findById(active._id)).not.toBeNull();
  });
});
