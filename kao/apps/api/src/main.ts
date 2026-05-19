import "dotenv/config";
import { loadConfig } from "./config.js";
import { logger } from "./lib/logger.js";
import { closeMongo, connectMongo } from "./storage/mongo.js";
import { ensureGrantIndexes } from "./storage/grants.js";
import { createApp } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const db = await connectMongo(config);
  await ensureGrantIndexes(db);
  const app = createApp({ db, config });

  const server = app.listen(config.PORT, config.KAO_HOST, () => {
    logger.info({ host: config.KAO_HOST, port: config.PORT }, "kao api listening");
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    // Await server.close — in-flight requests must finish draining before
    // we yank the Mongo connection out from under them.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeMongo();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((err) => {
  logger.fatal({ error: err }, "boot failed");
  process.exit(1);
});
