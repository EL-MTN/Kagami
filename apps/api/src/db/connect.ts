import mongoose from 'mongoose';
import type { Logger } from '../lib/logger.js';

export type DbHandle = {
  conn: typeof mongoose;
  ping: () => Promise<boolean>;
  close: () => Promise<void>;
};

export async function connectDb(uri: string, logger: Logger): Promise<DbHandle> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5_000 });
  logger.info({ uri: redactUri(uri) }, 'mongo connected');

  const results = await mongoose.syncIndexes();
  logger.info({ models: Object.keys(results) }, 'mongo indexes synced');

  return {
    conn: mongoose,
    ping: async () => {
      const db = mongoose.connection.db;
      if (!db) return false;
      const res = await db.admin().ping();
      return res?.ok === 1;
    },
    close: async () => {
      await mongoose.disconnect();
    },
  };
}

function redactUri(uri: string): string {
  return uri.replace(/\/\/[^@/]*@/, '//***@');
}
