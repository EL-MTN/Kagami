import { afterEach, describe, expect, it, vi } from "vitest";

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

import type { ActivityKind, PlatformAdapter } from "@kokoro/shared";
import {
  startActivity,
  wrapExecuteWithStage,
  type ActivityHandle,
} from "../../src/services/activity";

function adapterWith(
  sendActivity?: (chatId: string, kind: ActivityKind) => Promise<void>,
): PlatformAdapter {
  return { platform: "test", sendActivity } as unknown as PlatformAdapter;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startActivity", () => {
  it("emits typing immediately and re-emits every beat", () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const handle = startActivity(adapterWith(send), "c1");

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith("c1", "typing");

    vi.advanceTimersByTime(4_500);
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(4_500);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith("c1", "typing");

    handle.stop();
  });

  it("set() switches the verb immediately, beats carry it, reset() returns to typing", () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const handle = startActivity(adapterWith(send), "c1");

    handle.set("upload_photo");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("c1", "upload_photo");

    // Setting the same kind again does not re-emit out of band.
    handle.set("upload_photo");
    expect(send).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(4_500);
    expect(send).toHaveBeenLastCalledWith("c1", "upload_photo");

    handle.reset();
    expect(send).toHaveBeenLastCalledWith("c1", "typing");

    handle.stop();
  });

  it("stop() halts the heartbeat and ignores later set()", () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const handle = startActivity(adapterWith(send), "c1");
    handle.stop();

    const callsAfterStop = send.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    handle.set("record_voice");
    handle.reset();
    expect(send).toHaveBeenCalledTimes(callsAfterStop);
  });

  it("returns an inert handle when the adapter has no activity support", () => {
    vi.useFakeTimers();
    const handle = startActivity(adapterWith(undefined), "c1");
    // Nothing throws, nothing is scheduled.
    handle.set("upload_photo");
    handle.reset();
    handle.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("swallows emit failures — an indicator must never break a turn", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValue(new Error("telegram down"));
    const handle = startActivity(adapterWith(send), "c1");

    await vi.advanceTimersByTimeAsync(9_000);
    expect(send).toHaveBeenCalledTimes(3);

    handle.stop();
  });
});

describe("wrapExecuteWithStage", () => {
  function recordingHandle(): { handle: ActivityHandle; events: string[] } {
    const events: string[] = [];
    return {
      events,
      handle: {
        set: (kind) => events.push(`set:${kind}`),
        reset: () => events.push("reset"),
        stop: () => events.push("stop"),
      },
    };
  }

  it("sets the stage verb around execute and resets afterwards", async () => {
    const { handle, events } = recordingHandle();
    const wrapped = wrapExecuteWithStage(
      (args: { x: number }) => {
        events.push(`run:${args.x}`);
        return Promise.resolve(args.x * 2);
      },
      "upload_photo",
      () => handle,
    );

    await expect(wrapped({ x: 21 }, {})).resolves.toBe(42);
    expect(events).toEqual(["set:upload_photo", "run:21", "reset"]);
  });

  it("resets even when execute throws", async () => {
    const { handle, events } = recordingHandle();
    const wrapped = wrapExecuteWithStage(
      () => {
        throw new Error("boom");
      },
      "record_voice",
      () => handle,
    );

    await expect(wrapped({}, {})).rejects.toThrow("boom");
    expect(events).toEqual(["set:record_voice", "reset"]);
  });

  it("executes untouched when no activity handle exists", async () => {
    const wrapped = wrapExecuteWithStage(
      () => "ok",
      "upload_photo",
      () => undefined,
    );
    await expect(wrapped({}, {})).resolves.toBe("ok");
  });
});
