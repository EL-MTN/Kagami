import "dotenv/config";
import { MongoClient, type Db } from "mongodb";

// Lazy singleton. The client is constructed on first getDb() call so
// import-time side effects don't force a connection in code paths that
// don't need one (tests, scripts that only read paths, etc.).

const DEFAULT_URI = "mongodb://127.0.0.1:27017/?directConnection=true";
const DEFAULT_DB = "kioku";

let client: MongoClient | null = null;
let connectPromise: Promise<MongoClient> | null = null;
let dbName: string | null = null;

function getUri(): string {
  return process.env.KIOKU_MONGO_URI ?? DEFAULT_URI;
}

function getDbName(): string {
  return process.env.KIOKU_MONGO_DB ?? DEFAULT_DB;
}

async function getMongoClient(): Promise<MongoClient> {
  if (client) return client;
  // Cache the in-flight promise so two concurrent first-callers join the
  // same connect instead of each opening their own MongoClient and leaking
  // one. On connection failure, clear the cache so the next caller can
  // retry instead of replaying the rejected promise forever.
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
