import express, { type Express } from "express";
import { traceMiddleware } from "@kagami/logger/express-trace";
import type { Config } from "./config.js";
import type { DbHandle } from "./db/connect.js";
import { errors, makeErrorHandler } from "./lib/errors.js";
import { healthRouter } from "./routes/health.js";
import { peopleRouter } from "./routes/people.js";
import { organizationsRouter } from "./routes/organizations.js";
import { interactionsRouter } from "./routes/interactions.js";
import { followupsRouter } from "./routes/followups.js";
import { contextsRouter } from "./routes/contexts.js";
import { digestRouter } from "./routes/digest.js";
import { makeOauthRouter } from "./routes/oauth.js";
import { makeSyncRouter } from "./routes/sync.js";

type ServerDeps = {
  db: DbHandle;
  config: Config;
};

export function createApp({ db, config }: ServerDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  // Establish trace context before any route runs — pino mixin picks it up via
  // ALS, so every log line emitted inside a request carries traceId/spanId,
  // and outgoing tracedFetch calls (currently none in Kizuna) would propagate
  // it. Kokoro's HTTP clients sending `traceparent` will be linked correctly.
  app.use(traceMiddleware());

  app.use(healthRouter(db));

  // /oauth/* — open at localhost. The OS user is the trust boundary;
  // the callback is still CSRF-protected by signed state.
  app.use("/oauth", makeOauthRouter(config));

  app.use(peopleRouter);
  app.use(organizationsRouter);
  app.use(interactionsRouter);
  app.use(followupsRouter);
  app.use(contextsRouter);
  app.use(digestRouter);
  app.use(makeSyncRouter(config));

  app.use((_req, _res, next) => {
    next(errors.notFound("route not found"));
  });

  app.use(makeErrorHandler());
  return app;
}
