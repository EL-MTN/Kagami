import { logger } from "@kokoro/shared";
import crypto from "node:crypto";

/**
 * Thin REST client for the BlueBubbles server. The server runs on a Mac
 * and exposes its API at `BLUEBUBBLES_HOST` (e.g. `http://192.168.1.10:1234`)
 * authenticated via a shared `password` query string. Methods here cover
 * just the surfaces the bot uses today: send text and send attachment.
 *
 * Errors are bubbled as thrown `Error`s with the response body included so
 * the caller can log them. The adapter layer catches and logs at info
 * level; we don't retry — BlueBubbles is sensitive to flooding and the
 * caller already has retry signal via the LLM's tool result.
 */

interface BlueBubblesClientOptions {
  host: string;
  password: string;
}

interface SendTextOptions {
  chatGuid: string;
  message: string;
  /**
   * `apple-script` is the safer default — it queues sends through Messages.app.
   * `private-api` is faster and supports more features but requires the
   * BlueBubbles helper bundle. Default `apple-script` mirrors BlueBubbles' own
   * default for new installs.
   */
  method?: "apple-script" | "private-api";
}

interface SendAttachmentOptions {
  chatGuid: string;
  filename: string;
  buffer: Buffer;
  mimeType: string;
}

export class BlueBubblesClient {
  constructor(private readonly options: BlueBubblesClientOptions) {}

  private buildUrl(path: string): string {
    const base = this.options.host.replace(/\/$/, "");
    const sep = path.includes("?") ? "&" : "?";
    return `${base}${path}${sep}password=${encodeURIComponent(this.options.password)}`;
  }

  async sendText(opts: SendTextOptions): Promise<{ guid: string }> {
    const url = this.buildUrl("/api/v1/message/text");
    const tempGuid = crypto.randomUUID();
    const body = JSON.stringify({
      chatGuid: opts.chatGuid,
      tempGuid,
      message: opts.message,
      method: opts.method ?? "apple-script",
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`BlueBubbles sendText ${res.status}: ${text.slice(0, 300)}`);
    }
    logger.debug({ chatGuid: opts.chatGuid, tempGuid }, "BlueBubbles sendText ok");
    return { guid: tempGuid };
  }

  async sendAttachment(opts: SendAttachmentOptions): Promise<{ guid: string }> {
    const url = this.buildUrl("/api/v1/message/attachment");
    const tempGuid = crypto.randomUUID();
    const form = new FormData();
    form.set("chatGuid", opts.chatGuid);
    form.set("tempGuid", tempGuid);
    form.set("name", opts.filename);
    form.set(
      "attachment",
      new Blob([new Uint8Array(opts.buffer)], { type: opts.mimeType }),
      opts.filename,
    );
    const res = await fetch(url, { method: "POST", body: form });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`BlueBubbles sendAttachment ${res.status}: ${text.slice(0, 300)}`);
    }
    logger.debug(
      { chatGuid: opts.chatGuid, tempGuid, filename: opts.filename },
      "BlueBubbles sendAttachment ok",
    );
    return { guid: tempGuid };
  }
}
