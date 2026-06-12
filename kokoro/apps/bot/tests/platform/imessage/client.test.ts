import { afterEach, describe, expect, it, vi } from "vitest";
import { BlueBubblesClient } from "../../../src/platform/imessage/client";

// downloadAttachment must enforce its byte cap while STREAMING — a missing
// (or lying) Content-Length header must not let an oversized attachment
// buffer fully into the bot process before the size check.

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

const client = new BlueBubblesClient({ host: "http://bb.test", password: "pw" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BlueBubblesClient.downloadAttachment", () => {
  it("returns the full buffer when under the cap (no Content-Length)", async () => {
    const chunks = [new Uint8Array(10).fill(1), new Uint8Array(10).fill(2)];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(streamOf(chunks))));

    const buf = await client.downloadAttachment("guid-1", 25);
    expect(buf.length).toBe(20);
    expect(buf[0]).toBe(1);
    expect(buf[19]).toBe(2);
  });

  it("aborts mid-stream once the cap is crossed instead of buffering everything", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(10).fill(7));
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(endless)));

    await expect(client.downloadAttachment("guid-2", 25)).rejects.toThrow(/exceeds 25 bytes/);
    // 3 chunks (30 bytes) cross the 25-byte cap; the stream must not have
    // been drained much past that point.
    expect(pulled).toBeLessThanOrEqual(5);
  });

  it("rejects early on an honest oversized Content-Length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(streamOf([new Uint8Array(10)]), {
          headers: { "content-length": "999" },
        }),
      ),
    );

    await expect(client.downloadAttachment("guid-3", 25)).rejects.toThrow(/999 bytes \(cap 25\)/);
  });
});
