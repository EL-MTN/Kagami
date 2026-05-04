import 'dotenv/config';
import { MongoClient, type Db } from 'mongodb';

// Lazy singleton. The client is constructed on first getDb() call so
// import-time side effects don't force a connection in code paths that
// don't need one (tests, scripts that only read paths, etc.).

const DEFAULT_URI = 'mongodb://127.0.0.1:27017/?directConnection=true';
const DEFAULT_DB = 'kioku';

let client: MongoClient | null = null;
let dbName: string | null = null;

function getUri(): string {
  return process.env.KIOKU_MONGO_URI ?? DEFAULT_URI;
}

function getDbName(): string {
  return process.env.KIOKU_MONGO_DB ?? DEFAULT_DB;
}

export async function getMongoClient(): Promise<MongoClient> {
  if (client) return client;
  const c = new MongoClient(getUri());
  await c.connect();
  client = c;
  return c;
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
  dbName = null;
  await c.close();
}

// For tests: lets us swap in a memory-server URI per-process before the
// first getDb() call. Throws if a client is already open.
export function setMongoConfig(opts: { uri?: string; dbName?: string }): void {
  if (client) throw new Error('setMongoConfig: client already connected');
  if (opts.uri) process.env.KIOKU_MONGO_URI = opts.uri;
  if (opts.dbName) process.env.KIOKU_MONGO_DB = opts.dbName;
}
