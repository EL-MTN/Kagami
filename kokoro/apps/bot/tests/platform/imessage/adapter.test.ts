import { describe, expect, it, vi } from "vitest";

vi.mock("@kokoro/shared", async (orig) => ({
  ...(await orig<typeof import("@kokoro/shared")>()),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  BlueBubblesAdapter,
  normalizeWebhookEvent,
  type BlueBubblesMessageEvent,
} from "../../../src/platform/imessage/adapter";
import type { BlueBubblesClient } from "../../../src/platform/imessage/client";

function stubClient() {
  return {
    sendText: vi.fn().mockResolvedValue({ guid: "t-1" }),
    sendAttachment: vi.fn().mockResolvedValue({ guid: "a-1" }),
  };
}

function event(overrides: {
  text?: string | null;
  attachments?: BlueBubblesMessageEvent["data"]["attachments"];
}): BlueBubblesMessageEvent {
  return {
    type: "new-message",
    data: {
      guid: "msg-guid-1",
      text: overrides.text ?? null,
      chats: [{ guid: "iMessage;-;+15551234567" }],
      handle: { address: "+15551234567" },
      isFromMe: false,
      attachments: overrides.attachments,
    },
  };
}

describe("BlueBubblesAdapter.sendFileBuffer", () => {
  it("sends the attachment with filename and mime, no caption bubble by default", async () => {
    const client = stubClient();
    const adapter = new BlueBubblesAdapter(client as unknown as BlueBubblesClient);

    await adapter.sendFileBuffer(
      "imessage:iMessage;-;+15551234567",
      Buffer.from("pdf bytes"),
      "lease.pdf",
      "application/pdf",
    );

    expect(client.sendAttachment).toHaveBeenCalledWith({
      chatGuid: "iMessage;-;+15551234567",
      filename: "lease.pdf",
      buffer: Buffer.from("pdf bytes"),
      mimeType: "application/pdf",
    });
    expect(client.sendText).not.toHaveBeenCalled();
  });

  it("sends a caption as a follow-up text bubble", async () => {
    const client = stubClient();
    const adapter = new BlueBubblesAdapter(client as unknown as BlueBubblesClient);

    await adapter.sendFileBuffer("imessage:abc", Buffer.from("x"), "a.bin", undefined, "here!");

    expect(client.sendAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "application/octet-stream" }),
    );
    expect(client.sendText).toHaveBeenCalledWith({ chatGuid: "abc", message: "here!" });
  });
});

describe("normalizeWebhookEvent — document attachments", () => {
  it("decodes an inlined document into documentBuffer with name and mime", () => {
    const normalized = normalizeWebhookEvent(
      event({
        text: "check this out",
        attachments: [
          {
            guid: "att-1",
            mimeType: "application/pdf",
            transferName: "lease.pdf",
            data: Buffer.from("pdf bytes").toString("base64"),
          },
        ],
      }),
    );

    expect(normalized).not.toBeNull();
    expect(normalized!.pendingDocument).toBeUndefined();
    expect(normalized!.message.documentBuffer?.toString()).toBe("pdf bytes");
    expect(normalized!.message.documentMimeType).toBe("application/pdf");
    expect(normalized!.message.documentFileName).toBe("lease.pdf");
    expect(normalized!.message.text).toBe("check this out");
  });

  it("returns a pendingDocument when the payload has no inline data", () => {
    const normalized = normalizeWebhookEvent(
      event({
        attachments: [{ guid: "att-2", mimeType: "text/csv", transferName: "data.csv" }],
      }),
    );

    expect(normalized).not.toBeNull();
    expect(normalized!.message.documentBuffer).toBeUndefined();
    expect(normalized!.pendingDocument).toEqual({
      guid: "att-2",
      mimeType: "text/csv",
      fileName: "data.csv",
    });
    // No caption: text stays empty; the webhook handler / handleMessage adds markers.
    expect(normalized!.message.text).toBe("");
  });

  it("drops an oversized inline document with an honest marker", () => {
    const big = Buffer.alloc(26 * 1024 * 1024).toString("base64");
    const normalized = normalizeWebhookEvent(
      event({
        text: "the file",
        attachments: [
          { guid: "att-3", mimeType: "application/zip", transferName: "huge.zip", data: big },
        ],
      }),
    );

    expect(normalized).not.toBeNull();
    expect(normalized!.message.documentBuffer).toBeUndefined();
    expect(normalized!.pendingDocument).toBeUndefined();
    expect(normalized!.message.text).toBe(
      'the file\n[file "huge.zip" too large to receive — 25 MB cap]',
    );
  });

  it("keeps the legacy [attachment] placeholder for a no-data image with no text", () => {
    const normalized = normalizeWebhookEvent(
      event({ attachments: [{ guid: "att-4", mimeType: "image/jpeg" }] }),
    );

    expect(normalized).not.toBeNull();
    expect(normalized!.message.text).toBe("[attachment]");
    expect(normalized!.pendingDocument).toBeUndefined();
  });

  it("still returns null for an empty event with no attachment", () => {
    expect(normalizeWebhookEvent(event({}))).toBeNull();
  });
});
