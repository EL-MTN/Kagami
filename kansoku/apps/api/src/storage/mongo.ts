import "dotenv/config";
import { MongoClient, type Db } from "mongodb";
import { logger } from "../logger.js";

const DEFAULT_URI = "mongodb://127.0.0.1:27017/kansoku?directConnection=true";
const FALLBACK_DB = "kansoku";

let client: MongoClient | null = null;
let connectPromise: Promise<MongoClient> | null = null;
let dbName: string | null = null;

function getUri(): string {
  return process.env.MONGODB_URI ?? DEFAULT_URI;
}

// Read the database name from the URI's path. MongoClient.db() with no args
// returns the URI's default DB (or "test" if none was specified) — we treat
// "test" as "URI didn't specify" and fall back to the canonical service name
// so a misconfigured URI doesn't silently write to the wrong database.
function resolveDbName(c: MongoClient): string {
  const fromUri = c.db().databaseName;
  return fromUri && fromUri !== "test" ? fromUri : FALLBACK_DB;
}

/**
 * Reset the cached singleton so the next `getDb()` call opens a fresh
 * client. Intended for liveness recovery (close events, topology poison)
 * and graceful shutdown. Always clears `connectPromise` too so an
 * in-flight or already-resolved promise that points at a dead client
 * can't keep being handed out.
 */
function resetSingleton(reason: string): void {
  // Idempotent — if both client and connectPromise are already null, no-op.
  if (!client && !connectPromise) return;
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
      try {
        await c.connect();
        // Register the close listener only after a successful connect so a
        // close-during-connect window doesn't fire `resetSingleton` while
        // `client` is still null and leave a stale `connectPromise` behind
        // pointing at a doomed client.
        c.on("close", () => resetSingleton("client emitted close"));
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
