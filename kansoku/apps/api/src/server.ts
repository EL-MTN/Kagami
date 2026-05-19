import "dotenv/config";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler } from "express";
import { pinoHttp } from "pino-http";
import { ZodError } from "zod";
import { traceMiddleware } from "@kagami/logger/express-trace";
import { logger } from "./logger.js";
import { corsForDashboard } from "./lib/cors.js";
import { metaRouter } from "./routes/meta.js";
import { createIngestRouter } from "./routes/ingest.js";
import { queryRouter } from "./routes/query.js";
import { tailRouter } from "./routes/tail.js";
import { errorsRouter } from "./routes/errors.js";
import { servicesRouter } from "./routes/services.js";
import { ensureIndexes } from "./storage/indexes.js";
import { closeMongo } from "./storage/mongo.js";

// `PORT` is injected by `portless run`; 7779 is the standalone fallback
// (Kioku owns 7777, Kansoku takes 7779).
const PORT = Number.parseInt(process.env.PORT ?? "7779", 10);
const HOST = process.env.KANSOKU_HOST ?? "127.0.0.1";

export function createApp(opts: { ingestToken: string | undefined }): express.Express {
  const app = express();
  app.set("trust proxy", "loopback");
  // Trace context absolutely first so every log inside the request —
  // including body-parse errors (PayloadTooLargeError, malformed JSON)
  // and pino-http's completion log — carries traceId/spanId.
  app.use(traceMiddleware());
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: "4mb" }));

  app.use("/", metaRouter);
  app.use("/v1", corsForDashboard);
  app.use("/v1", createIngestRouter(opts.ingestToken));
  app.use("/v1", queryRouter);
  app.use("/v1", tailRouter);
  app.use("/v1", errorsRouter);
  app.use("/v1", servicesRouter);

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "validation_error", issues: err.issues });
      return;
    }
    // Body-parser surfaces status-bearing errors for malformed JSON (400)
    // and oversized payloads (413, `entity.too.large`). Honor those before
    // falling through to 500 so misconfigured shippers get a meaningful
    // response instead of a mystery server error.
    const httpErr = err as { status?: number; statusCode?: number; expose?: boolean };
    const status = httpErr.status ?? httpErr.statusCode;
    if (typeof status === "number" && status >= 400 && status < 600) {
      // Log the original message so operators can diagnose; do NOT echo it
      // to the client — body-parser's JSON-parse message includes the
      // offending byte position and a snippet of the request body, which
      // is mild information disclosure on an otherwise unauthenticated
      // 401-gated surface.
      req.log.warn({ err: (err as Error).message, status }, "request rejected");
      if (!res.headersSent) {
        const body =
          status === 413
            ? { error: "payload_too_large" }
            : status === 400
              ? { error: "bad_request" }
              : { error: "request_failed", status };
        res.status(status).json(body);
      }
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
    // Await server.close — in-flight requests must finish draining before
    // we yank the Mongo connection out from under them.
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
