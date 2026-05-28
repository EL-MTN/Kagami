import express, { type Express } from "express";
import { traceMiddleware } from "@kagami/logger/express-trace";
import type { Db } from "mongodb";
import type { Config } from "./config.js";
import { requireBearer } from "./lib/auth.js";
import { errors, makeErrorHandler } from "./lib/errors.js";
import { healthRouter } from "./routes/health.js";
import { homeRouter } from "./routes/home.js";
import { makeOauthRouter } from "./routes/oauth.js";
import { makeGrantsRouter } from "./routes/grants.js";

type ServerDeps = {
  db: Db;
  config: Config;
};

export function createApp({ db, config }: ServerDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  // Trace context before any route — the pino mixin reads it via ALS so every
  // log line inside a request carries traceId/spanId, and an incoming
  // traceparent (e.g. from a sibling's tracedFetch) links correctly.
  app.use(traceMiddleware());

  app.use(healthRouter());

  // Open at localhost — operator-browser surfaces. The home page holds no
  // secret; the consent flow is CSRF-state-protected (state binds the grant).
  app.use(homeRouter(db));
  app.use("/oauth", makeOauthRouter(config, db));

  // The vend surface: always bearer-gated, even at localhost. This is the one
  // service in the workspace that does not inherit the open-at-localhost
  // posture — it holds a send/write-scoped Google credential.
  app.use("/grants", requireBearer(config.KAO_TOKEN), makeGrantsRouter(config, db));

  app.use((_req, _res, next) => {
    next(errors.notFound("route not found"));
  });

  app.use(makeErrorHandler());
  return app;
}
