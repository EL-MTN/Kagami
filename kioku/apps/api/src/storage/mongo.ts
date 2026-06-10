import "dotenv/config";
import { MongoClient, type Db } from "mongodb";
import { loadEnv } from "../config.js";

// Lazy singleton. The client is constructed on first getDb() call so
// import-time side effects don't force a connection in code paths that
// don't need one (tests, scripts that only read paths, etc.).

const FALLBACK_DB = "kioku";

let client: MongoClient | null = null;
let connectPromise: Promise<MongoClient> | null = null;
let dbName: string | null = null;

function getUri(): string {
  return loadEnv().MONGODB_URI;
}

// Read the database name from the URI's path. MongoClient.db() with no args
// returns the URI's default DB (or "test" if none was specified) — we treat
// "test" as "URI didn't specify" and fall back to the canonical service name
// so a misconfigured URI doesn't silently write to the wrong database.
function resolveDbName(c: MongoClient): string {
  const fromUri = c.db().databaseName;
  return fromUri && fromUri !== "test" ? fromUri : FALLBACK_DB;
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
  if (!dbName) dbName = resolveDbName(c);
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
