import { MongoClient, type Db } from "mongodb";
import type { Config } from "../config.js";

// Lazy singleton, same shape as Kioku's storage/mongo.ts: the client is
// constructed on first getDb() and the in-flight connect promise is cached so
// concurrent first-callers join one connection instead of leaking sockets.

let client: MongoClient | null = null;
let connectPromise: Promise<MongoClient> | null = null;

export async function connectMongo(config: Config): Promise<Db> {
  if (client) return client.db(config.KAO_DB_NAME);
  if (!connectPromise) {
    connectPromise = (async () => {
      const c = new MongoClient(config.MONGODB_URI);
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
  const c = await connectPromise;
  return c.db(config.KAO_DB_NAME);
}

export async function closeMongo(): Promise<void> {
  if (!client) return;
  const c = client;
  client = null;
  connectPromise = null;
  await c.close();
}
