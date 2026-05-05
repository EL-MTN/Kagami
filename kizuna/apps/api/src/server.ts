import express, { type Express } from "express";
import type { Config } from "./config.js";
import type { DbHandle } from "./db/connect.js";
import { bearerAuth } from "./lib/auth.js";
import { errors, makeErrorHandler } from "./lib/errors.js";
import { healthRouter } from "./routes/health.js";
import { peopleRouter } from "./routes/people.js";
import { organizationsRouter } from "./routes/organizations.js";
import { interactionsRouter } from "./routes/interactions.js";
import { followupsRouter } from "./routes/followups.js";
import { contextsRouter } from "./routes/contexts.js";
import { digestRouter } from "./routes/digest.js";
import { manifestRouter } from "./routes/manifest.js";
import { makeOauthRouter } from "./routes/oauth.js";
import { makeSyncRouter } from "./routes/sync.js";

export type ServerDeps = {
  db: DbHandle;
  config: Config;
};

export function createApp({ db, config }: ServerDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.use(healthRouter(db));

  // /oauth/* — handlers do their own key check (header OR ?key=) so the
  // browser can land here from a plain <a href>. Callback uses signed-state CSRF.
  app.use("/oauth", makeOauthRouter(config));

  app.use("/v1", bearerAuth(config.KIZUNA_API_KEY));
  app.use("/v1", manifestRouter);
  app.use("/v1", peopleRouter);
  app.use("/v1", organizationsRouter);
  app.use("/v1", interactionsRouter);
  app.use("/v1", followupsRouter);
  app.use("/v1", contextsRouter);
  app.use("/v1", digestRouter);
  app.use("/v1", makeSyncRouter(config));

  app.use((_req, _res, next) => {
    next(errors.notFound("route not found"));
  });

  app.use(makeErrorHandler());
  return app;
}
