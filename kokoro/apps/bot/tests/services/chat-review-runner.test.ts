import { fakeAdapter } from "@kokoro/test-utils";
import { describe, expect, it, vi } from "vitest";

vi.mock("@kokoro/shared", async (orig) => ({
  ...(await orig()),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

import { AdapterRegistry } from "../../src/platform/registry";
import { runReviewForEachChat } from "../../src/services/chat-review-runner";

/** Drain the microtask queue plus one macrotask so queued passes get a chance to (wrongly) start. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function telegramRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(fakeAdapter());
  return registry;
}

describe("runReviewForEachChat", () => {
  it("serializes overlapping passes FIFO — the second never starts until the first finishes", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = telegramRegistry();

    const first = runReviewForEachChat({
      label: "first",
      registry,
      listChatIds: () => Promise.resolve(["123"]),
      review: async () => {
        order.push("first:start");
        await gate;
        order.push("first:end");
        return 0;
      },
    });
    const second = runReviewForEachChat({
      label: "second",
      registry,
      listChatIds: () => {
        order.push("second:listChatIds");
        return Promise.resolve(["123"]);
      },
      review: () => {
        order.push("second:review");
        return Promise.resolve(0);
      },
    });

    await flush();
    // The second pass is queued behind the first, not interleaved with it —
    // it hasn't even enumerated chats while the first holds the chain. This
    // is what protects the read-then-insert pending-confirmation guard from
    // two passes both seeing "no pending" and stacking confirmations.
    expect(order).toEqual(["first:start"]);

    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:listChatIds", "second:review"]);
  });

  it("a failed pass rejects its own caller but the next queued pass still runs", async () => {
    const registry = telegramRegistry();

    const first = runReviewForEachChat({
      label: "first",
      registry,
      listChatIds: () => Promise.reject(new Error("mongo down")),
      review: () => Promise.resolve(0),
    });
    const review = vi.fn().mockResolvedValue(0);
    const second = runReviewForEachChat({
      label: "second",
      registry,
      listChatIds: () => Promise.resolve(["123"]),
      review,
    });

    await expect(first).rejects.toThrow("mongo down");
    await second;
    expect(review).toHaveBeenCalledWith("123", expect.anything());
  });

  it("isolates per-chat review failures — one bad chat never blocks the rest", async () => {
    const reviewed: string[] = [];

    await runReviewForEachChat({
      label: "pass",
      registry: telegramRegistry(),
      listChatIds: () => Promise.resolve(["1", "2", "3"]),
      review: (chatId) => {
        if (chatId === "2") return Promise.reject(new Error("boom"));
        reviewed.push(chatId);
        return Promise.resolve(0);
      },
    });

    expect(reviewed).toEqual(["1", "3"]);
  });

  it("skips chats whose platform has no registered adapter", async () => {
    const reviewed: string[] = [];

    await runReviewForEachChat({
      label: "pass",
      registry: telegramRegistry(), // telegram only — no imessage adapter
      listChatIds: () => Promise.resolve(["imessage:guid-1", "123"]),
      review: (chatId) => {
        reviewed.push(chatId);
        return Promise.resolve(0);
      },
    });

    expect(reviewed).toEqual(["123"]);
  });
});
