import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { ZodError } from "zod";
import { traceMiddleware } from "@kagami/logger/express-trace";
import { logger } from "./logger.js";
import { metaRouter } from "./routes/meta.js";
import { factsRouter } from "./routes/facts.js";
import { recallRouter } from "./routes/recall.js";
import { queryRouter } from "./routes/query.js";
import { sessionsRouter } from "./routes/sessions.js";
import { mcpRouter } from "./mcp.js";
import { getBm25ParamConfig } from "./retrieval/scoring.js";
import { ensureIndexes } from "./storage/indexes.js";
import { closeMongo } from "./storage/mongo.js";

// `PORT` is injected by `portless run`; 7777 is the standalone fallback.
const PORT = Number.parseInt(process.env.PORT ?? "7777", 10);
const HOST = process.env.KIOKU_HOST ?? "127.0.0.1";

const app = express();

// Portless runs as a local reverse proxy; trust loopback so req.ip reflects
// the forwarded client for per-IP rate limits without trusting arbitrary peers.
app.set("trust proxy", "loopback");

// Trace context absolutely first so every log inside the request — including
// body-parse errors (`PayloadTooLargeError`, malformed JSON) and pino-http's
// completion log — carries traceId/spanId. When this Kioku request was
// triggered by Kokoro via tracedFetch, the incoming `traceparent` is
// preserved as the parent of the span we open here.
app.use(traceMiddleware());
app.use(
  pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === "/health" },
    customLogLevel: (_req, res, err) => {
      if (err) return "error";
      if (res.statusCode >= 500) return "silent";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    customAttributeKeys: { err: "error" },
    serializers: {
      error: pino.stdSerializers.err,
      req: (req: { method?: string; url?: string; id?: string | number }) => ({
        method: req.method,
        url: req.url,
        id: req.id,
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  }),
);
// Transcripts can be sizeable; bump beyond the 100kb default.
app.use(express.json({ limit: "10mb" }));

app.use("/", metaRouter);
app.use("/facts", factsRouter);
app.use("/recall", recallRouter);
app.use("/query", queryRouter);
app.use("/sessions", sessionsRouter);
app.use("/mcp", mcpRouter);

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "validation_error", issues: err.issues });
    return;
  }
  // req.path (no query string) — keep query-string secrets like OAuth
  // callback codes or CSRF state tokens out of error logs. Kioku has no
  // OAuth callback today, but enforce the convention workspace-wide.
  req.log.error({ error: err, method: req.method, url: req.path }, "unhandled request error");
  if (!res.headersSent) {
    res.status(500).json({ error: "internal_error" });
  }
};
app.use(errorHandler);

async function main(): Promise<void> {
  logger.debug({ bm25Sigmoid: getBm25ParamConfig() }, "bm25 sigmoid params configured");

  try {
    await ensureIndexes();
  } catch (err) {
    logger.error({ error: err }, "kioku startup failed");
    process.exit(1);
  }

  const server = app.listen(PORT, HOST, () => {
    logger.info({ host: HOST, port: PORT }, "kioku http server listening");
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    // Await server.close — in-flight requests must finish draining before
    // we yank the Mongo connection out from under them.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeMongo();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
