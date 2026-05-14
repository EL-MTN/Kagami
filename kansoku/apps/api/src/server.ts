import "dotenv/config";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler } from "express";
import { pinoHttp } from "pino-http";
import { ZodError } from "zod";
import { logger } from "./logger.js";
import { corsForDashboard } from "./lib/cors.js";
import { metaRouter } from "./routes/meta.js";
import { createIngestRouter } from "./routes/ingest.js";
import { queryRouter } from "./routes/query.js";
import { tailRouter } from "./routes/tail.js";
import { ensureIndexes } from "./storage/indexes.js";
import { closeMongo } from "./storage/mongo.js";

// `PORT` is injected by `portless run`; 7779 is the standalone fallback
// (Kioku owns 7777, Kansoku takes 7779).
const PORT = Number.parseInt(process.env.PORT ?? "7779", 10);
const HOST = process.env.KANSOKU_HOST ?? "127.0.0.1";

export function createApp(opts: { ingestToken: string | undefined }): express.Express {
  const app = express();
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: "4mb" }));
  app.use(pinoHttp({ logger }));

  app.use("/", metaRouter);
  app.use("/v1", corsForDashboard);
  app.use("/v1", createIngestRouter(opts.ingestToken));
  app.use("/v1", queryRouter);
  app.use("/v1", tailRouter);

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

  return app;
}

async function main(): Promise<void> {
  const ingestToken = process.env.KANSOKU_INGEST_TOKEN;
  if (!ingestToken) {
    logger.warn(
      "KANSOKU_INGEST_TOKEN is unset — POST /v1/logs will return 503 until it is configured",
    );
  }

  try {
    await ensureIndexes();
  } catch (err) {
    logger.error({ err: (err as Error).message }, "kansoku startup failed");
    process.exit(1);
  }

  const app = createApp({ ingestToken });

  const server = app.listen(PORT, HOST, () => {
    logger.info({ host: HOST, port: PORT }, "kansoku http server listening");
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

// Only run main() when this module is the process entry point. Tests import
// `createApp` from here and would otherwise trigger a real listen() + Mongo
// connect on every import.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
