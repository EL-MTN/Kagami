import type { Express } from 'express';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { loadConfig } from '../../src/config.js';
import { connectDb, type DbHandle } from '../../src/db/connect.js';
import '../../src/db/models/index.js';
import { createLogger } from '../../src/lib/logger.js';
import { createApp } from '../../src/server.js';

export type TestHarness = {
  app: Express;
  db: DbHandle;
  apiKey: string;
  uri: string;
  stop: () => Promise<void>;
};

export const TEST_API_KEY = 'test-api-key-1234567890abcdef';

export async function startHarness(): Promise<TestHarness> {
  const container: StartedTestContainer = await new GenericContainer('mongo:7')
    .withExposedPorts(27017)
    .start();

  const uri = `mongodb://${container.getHost()}:${container.getMappedPort(27017)}/kizuna_test`;

  const config = loadConfig({
    KIZUNA_API_KEY: TEST_API_KEY,
    MONGO_URI: uri,
    USER_EMAILS: 'test@example.com',
    LOG_LEVEL: 'silent',
  });

  const logger = createLogger(config.LOG_LEVEL);
  const db = await connectDb(config.MONGO_URI, logger);
  const app = createApp({ db, config, logger });

  return {
    app,
    db,
    apiKey: TEST_API_KEY,
    uri,
    stop: async () => {
      await db.close();
      await container.stop();
    },
  };
}
