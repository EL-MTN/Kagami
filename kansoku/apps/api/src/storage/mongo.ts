import "dotenv/config";
import { MongoClient, type Db } from "mongodb";
import { logger } from "../logger.js";

const DEFAULT_URI = "mongodb://127.0.0.1:27017/?directConnection=true";
const DEFAULT_DB = "kansoku";

let client: MongoClient | null = null;
let connectPromise: Promise<MongoClient> | null = null;
let dbName: string | null = null;

function getUri(): string {
  return process.env.KANSOKU_MONGO_URI ?? DEFAULT_URI;
}

function getDbName(): string {
  return process.env.KANSOKU_MONGO_DB ?? DEFAULT_DB;
}

/**
 * Reset the cached singleton so the next `getDb()` call opens a fresh
 * client. Intended for liveness recovery (close events, topology poison)
 * and graceful shutdown.
 */
function resetSingleton(reason: string): void {
  if (!client) return;
  logger.warn({ reason }, "mongo singleton reset");
  client = null;
  connectPromise = null;
  dbName = null;
}

async function getMongoClient(): Promise<MongoClient> {
  if (client) return client;
  // Two concurrent first-callers share the in-flight connect so we don't open
  // two MongoClients. On failure, clear the cached promise so the next caller
  // can retry instead of replaying the rejected one forever.
  if (!connectPromise) {
    connectPromise = (async () => {
      const c = new MongoClient(getUri());
      // Hook liveness events so a dead client doesn't poison every future
      // request silently. The driver handles internal topology reconnects,
      // but at the connection-level a `close` event (graceful or otherwise)
      // means we should drop the cached handle and let the next call open
      // a fresh client. Subscribing here once at construction is cheap.
      c.on("close", () => resetSingleton("client emitted close"));
      try {
        await c.connect();
        client = c;
        return c;
      } catch (err) {
        connectPromise = null;
        throw err;
      }
    })();
  }
  return connectPromise;
}

export async function getDb(): Promise<Db> {
  const c = await getMongoClient();
  if (!dbName) dbName = getDbName();
  return c.db(dbName);
}

export async function closeMongo(): Promise<void> {
  if (!client) return;
  const c = client;
  client = null;
  connectPromise = null;
  dbName = null;
  await c.close();
}
