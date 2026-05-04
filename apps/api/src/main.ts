import 'dotenv/config';
import { loadConfig } from './config.js';
import { createLogger } from './lib/logger.js';
import { connectDb } from './db/connect.js';
import './db/models/index.js';
import { startIngestScheduler } from './ingest/scheduler.js';
import { createApp } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  const db = await connectDb(config.MONGO_URI, logger);
  const app = createApp({ db, config, logger });

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'kizuna api listening');
  });
  const scheduler = startIngestScheduler({ config, logger });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    scheduler.stop();
    server.close();
    await db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[boot] fatal:', err);
  process.exit(1);
});
