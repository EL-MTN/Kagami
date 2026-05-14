import "dotenv/config";
import { MongoClient, type Db } from "mongodb";

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

async function getMongoClient(): Promise<MongoClient> {
  if (client) return client;
  // Two concurrent first-callers share the in-flight connect so we don't open
  // two MongoClients. On failure, clear the cached promise so the next caller
  // can retry instead of replaying the rejected one forever.
  if (!connectPromise) {
    connectPromise = (async () => {
      const c = new MongoClient(getUri());
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
