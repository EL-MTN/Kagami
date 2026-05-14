import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import { pinoHttp } from "pino-http";
import { ZodError } from "zod";
import { logger } from "./logger.js";
import { metaRouter } from "./routes/meta.js";

// `PORT` is injected by `portless run`; 7779 is the standalone fallback
// (Kioku owns 7777, Kizuna 7778-equivalent, Kansoku takes 7779).
const PORT = Number.parseInt(process.env.PORT ?? "7779", 10);
const HOST = process.env.KANSOKU_HOST ?? "127.0.0.1";

const app = express();

// Portless runs as a local reverse proxy; trust loopback so req.ip reflects
// the forwarded client without trusting arbitrary peers.
app.set("trust proxy", "loopback");

// Log ingest bodies will be sizeable (batched events from siblings).
// Phase 0 has no ingest route yet, but we set the limit up front so the
// Phase 1 ingest endpoint inherits it.
app.use(express.json({ limit: "4mb" }));
app.use(pinoHttp({ logger }));

app.use("/", metaRouter);

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

function main(): void {
  const server = app.listen(PORT, HOST, () => {
    logger.info({ host: HOST, port: PORT }, "kansoku http server listening");
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "shutting down");
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
