import http from "node:http";
import crypto from "node:crypto";
import { logger, config } from "@kokoro/shared";
import { attachResultText, listPendingConfirmations, resolvePendingConfirmation } from "@kokoro/db";
import { handleMessage } from "../../ai/generate";
import { dispatchGatedAction } from "../../services/gated-actions";
import { appendConfirmationResolution } from "../../services/confirmation-events";
import { generateAcknowledgment } from "../../ai/acknowledge";
import { resetTimer } from "../../scheduler/proactive";
import { BlueBubblesAdapter, normalizeWebhookEvent, type BlueBubblesMessageEvent } from "./adapter";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 15;
const DEDUPE_LRU_CAP = 200;
// Largest webhook body we'll accept. BlueBubbles inlines image attachments
// as base64; a 10 MB image becomes ~13 MB in JSON, plus envelope. 25 MB
// covers realistic attachments while keeping a hard ceiling on RAM.
const MAX_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024;

// Strict standalone match — must be the entire reply (with optional
// trailing punctuation/whitespace). Conversational phrases like
// "yes I think so" or "no thanks" must NOT auto-resolve a pending
// confirmation, since that would dispatch real actions (sendEmail,
// calendar deletes, browseAgent) on incidental chat. Anything that
// doesn't match falls through to the AI pipeline so Mashiro can
// disambiguate naturally.
const APPROVE_RE = /^(yes|y|approve|confirm)[.!]?\s*$/i;
const DENY_RE = /^(no|n|deny|reject|cancel)[.!]?\s*$/i;

/**
 * Bounded LRU set of recently seen message GUIDs. BlueBubbles sometimes
 * fires duplicate webhooks for the same message; without dedupe we'd
 * process the same incoming message twice.
 */
class GuidLru {
  private set = new Set<string>();
  has(guid: string): boolean {
    return this.set.has(guid);
  }
  add(guid: string): void {
    this.set.add(guid);
    if (this.set.size > DEDUPE_LRU_CAP) {
      const first = this.set.values().next().value;
      if (first) this.set.delete(first);
    }
  }
}

/** Per-handle in-memory rate limiter, mirrors the Telegram bot pattern. */
function makeRateLimiter(): (handle: string) => boolean {
  const buckets = new Map<string, number[]>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) {
      if (v.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) buckets.delete(k);
    }
  }, RATE_LIMIT_WINDOW_MS).unref();
  return (handle: string): boolean => {
    const now = Date.now();
    const arr = (buckets.get(handle) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    arr.push(now);
    buckets.set(handle, arr);
    return arr.length > RATE_LIMIT_MAX;
  };
}

/**
 * If exactly one confirmation is pending for this chat and the message
 * looks like a YES/NO reply, resolve it and return true. Otherwise return
 * false so the caller falls through to the standard AI pipeline.
 *
 * The "exactly one" rule keeps the trigger explicit — if more than one
 * is pending the LLM has to handle the disambiguation conversationally.
 */
async function tryResolveConfirmationReply(
  chatId: string,
  userId: string,
  text: string,
  adapter: BlueBubblesAdapter,
): Promise<boolean> {
  const isApprove = APPROVE_RE.test(text.trim());
  const isDeny = DENY_RE.test(text.trim());
  if (!isApprove && !isDeny) return false;

  const pending = await listPendingConfirmations(chatId);
  if (pending.length !== 1) return false;

  const row = pending[0];
  const verdict = isApprove ? "approved" : "denied";
  const confirmationId = String(row._id);

  const resolved = await resolvePendingConfirmation(confirmationId, verdict);
  if (!resolved) {
    // Lost the race to another resolver (e.g. cancelConfirmation tool fired
    // while this webhook was inflight). Treat as ambiguous — fall through.
    return false;
  }

  if (verdict === "denied") {
    await adapter.editConfirmationPrompt(chatId, "", `✗ Denied · ${row.summary}`);
    await appendConfirmationResolution(chatId, userId, {
      summary: row.summary,
      verdict: "denied",
    });
    logger.info({ confirmationId, chatId }, "iMessage confirmation denied via reply");
  } else {
    const dispatch = await dispatchGatedAction(row.action.tool, row.action.args);
    await attachResultText(confirmationId, dispatch.summary);
    const verdictMark = dispatch.success ? "✓ Approved" : "⚠ Approved · failed";
    await adapter.editConfirmationPrompt(
      chatId,
      "",
      `${verdictMark} · ${row.summary}\n${dispatch.summary}`,
    );
    await appendConfirmationResolution(chatId, userId, {
      summary: row.summary,
      verdict: "approved",
      success: dispatch.success,
      resultText: dispatch.summary,
    });
    logger.info(
      { confirmationId, chatId, success: dispatch.success },
      "iMessage confirmation approved via reply",
    );
  }

  // Fire-and-forget acknowledgment turn — Mashiro speaks in character.
  generateAcknowledgment(chatId, userId, adapter).catch((error) => {
    logger.warn({ err: error, confirmationId }, "Acknowledgment turn failed");
  });
  return true;
}

/**
 * Thrown by `readBody` when the request payload exceeds the byte cap.
 * The webhook handler catches this specifically and responds 413.
 */
class BodyTooLargeError extends Error {
  readonly statusCode = 413;
  constructor(maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
  }
}

/**
 * Read a request body as utf-8 with a hard size cap. Uses async iteration
 * so the read is fully async/await (per CLAUDE.md "no callbacks") and
 * bails as soon as the running total exceeds `maxBytes`, before fully
 * buffering an oversized payload into memory.
 */
async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  // Cheap up-front rejection if Content-Length advertises a huge body. The
  // header is absent for chunked-transfer-encoding requests, in which case
  // we skip the up-front check and rely on the streaming cap below.
  const advertisedHeader = req.headers["content-length"];
  if (advertisedHeader !== undefined) {
    const advertised = Number(advertisedHeader);
    if (Number.isFinite(advertised) && advertised > maxBytes) {
      throw new BodyTooLargeError(maxBytes);
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) throw new BodyTooLargeError(maxBytes);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// Per-process random key. Used to HMAC both the supplied and expected
// passwords before comparing — guarantees both inputs hash to the same
// fixed length (32 bytes) and `crypto.timingSafeEqual` is safe to call.
// Avoids the length-leak in a naive a.length !== b.length early-return.
const SAFE_EQUAL_KEY = crypto.randomBytes(32);

function safeEqual(a: string, b: string): boolean {
  const aMac = crypto.createHmac("sha256", SAFE_EQUAL_KEY).update(a).digest();
  const bMac = crypto.createHmac("sha256", SAFE_EQUAL_KEY).update(b).digest();
  return crypto.timingSafeEqual(aMac, bMac);
}

export interface StartWebhookOptions {
  port: number;
  /** Token expected on incoming webhook calls (?password=... or X-Webhook-Token). */
  password: string;
  adapter: BlueBubblesAdapter;
}

/**
 * Start the BlueBubbles webhook listener. Returns a stopper for graceful
 * shutdown. Routes:
 *   POST /webhook/bluebubbles → process inbound `new-message` events
 *   GET  /healthz             → liveness probe
 */
export function startBlueBubblesWebhook(opts: StartWebhookOptions): () => void {
  const dedupe = new GuidLru();
  const isRateLimited = makeRateLimiter();

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "GET" && req.url?.startsWith("/healthz")) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("ok");
          return;
        }
        if (req.method !== "POST" || !req.url?.startsWith("/webhook/bluebubbles")) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found");
          return;
        }

        // Auth: support either ?password=... query or X-Webhook-Token header.
        const url = new URL(req.url, "http://localhost");
        const queryPassword = url.searchParams.get("password");
        const headerPassword = (req.headers["x-webhook-token"] as string | undefined) ?? null;
        const supplied = headerPassword ?? queryPassword ?? "";
        if (!supplied || !safeEqual(supplied, opts.password)) {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("unauthorized");
          return;
        }

        let raw: string;
        try {
          raw = await readBody(req, MAX_WEBHOOK_BODY_BYTES);
        } catch (error) {
          if (error instanceof BodyTooLargeError) {
            res.writeHead(413, { "content-type": "text/plain" });
            res.end("payload too large");
            return;
          }
          throw error;
        }
        let event: BlueBubblesMessageEvent;
        try {
          event = JSON.parse(raw) as BlueBubblesMessageEvent;
        } catch {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("invalid json");
          return;
        }

        // Ack BlueBubbles immediately so it doesn't retry while we work.
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");

        const normalized = normalizeWebhookEvent(event);
        if (!normalized) return;
        const { message, messageGuid } = normalized;

        if (dedupe.has(messageGuid)) {
          logger.debug({ messageGuid }, "Duplicate iMessage webhook event, skipping");
          return;
        }
        dedupe.add(messageGuid);

        // Allowlist
        if (
          config.ALLOWED_IMESSAGE_HANDLES.length > 0 &&
          !config.ALLOWED_IMESSAGE_HANDLES.includes(message.userId)
        ) {
          logger.warn({ handle: message.userId }, "iMessage from non-allowlisted handle blocked");
          return;
        }

        if (isRateLimited(message.userId)) {
          logger.warn({ handle: message.userId }, "iMessage rate limited");
          return;
        }

        logger.info(
          { handle: message.userId, text: message.text.slice(0, 50) },
          "Incoming iMessage",
        );

        // Pre-AI confirmation parser. If this returns true the message is
        // fully handled — don't run the AI pipeline.
        const handled = await tryResolveConfirmationReply(
          message.chatId,
          message.userId,
          message.text,
          opts.adapter,
        );
        if (handled) {
          resetTimer(message.chatId, message.userId);
          return;
        }

        await handleMessage(message, opts.adapter);
        resetTimer(message.chatId, message.userId);
      } catch (error) {
        logger.error({ err: error }, "iMessage webhook handler error");
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("error");
        }
      }
    })();
  });

  server.listen(opts.port, () => {
    logger.info({ port: opts.port }, "BlueBubbles webhook listening");
  });

  return () => {
    server.close((err) => {
      if (err) logger.warn({ err }, "Error closing BlueBubbles webhook");
      else logger.info("BlueBubbles webhook stopped");
    });
  };
}
