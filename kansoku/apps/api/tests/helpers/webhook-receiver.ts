import { createServer, type Server } from "node:http";

/**
 * Spin up an in-process HTTP server that captures POST bodies as parsed
 * JSON objects. Replies 204 to every request. Use in egress tests
 * (alert webhooks, future Slack/Discord-shaped payloads) to assert on
 * what the SUT actually sent.
 */

export interface CapturedRequest {
  body: Record<string, unknown>;
}

export interface WebhookReceiver {
  url: string;
  captured: CapturedRequest[];
  close: () => Promise<void>;
}

export async function startWebhookReceiver(): Promise<WebhookReceiver> {
  const captured: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.length > 0) {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          captured.push({ body: parsed });
        }
      } catch {
        // Malformed bodies are dropped — callers assert on `captured`.
      }
      res.statusCode = 204;
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("webhook receiver did not bind to a port");
  }
  const url = `http://127.0.0.1:${addr.port}/`;

  return {
    url,
    captured,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
