import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import { pinoHttp } from "pino-http";
import { ZodError } from "zod";
import { logger } from "./logger.js";
import { metaRouter } from "./routes/meta.js";
import { factsRouter } from "./routes/facts.js";
import { recallRouter } from "./routes/recall.js";
import { queryRouter } from "./routes/query.js";
import { sessionsRouter } from "./routes/sessions.js";
import { mcpRouter } from "./mcp.js";
import { ensureIndexes } from "./storage/indexes.js";
import { closeMongo } from "./storage/mongo.js";

// `PORT` is injected by `portless run`; 7777 is the standalone fallback.
const PORT = Number.parseInt(process.env.PORT ?? "7777", 10);
const HOST = process.env.KIOKU_HOST ?? "127.0.0.1";

const app = express();

// Transcripts can be sizeable; bump beyond the 100kb default.
app.use(express.json({ limit: "10mb" }));
app.use(pinoHttp({ logger }));

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
  req.log.error({ err: (err as Error).message }, "unhandled request error");
  if (!res.headersSent) {
    res.status(500).json({ error: "internal_error" });
  }
};
app.use(errorHandler);

async function main(): Promise<void> {
  try {
    await ensureIndexes();
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      "failed to initialize MongoDB — is the atlas-local container running on KIOKU_MONGO_URI?",
    );
    process.exit(1);
  }

  const server = app.listen(PORT, HOST, () => {
    logger.info({ host: HOST, port: PORT }, "kioku http server listening");
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    server.close();
    await closeMongo();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
