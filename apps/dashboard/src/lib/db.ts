import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/kokoro";

interface CachedConnection {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

declare global {
  var __mongooseCache: CachedConnection | undefined;
}

const cached: CachedConnection = globalThis.__mongooseCache ?? { conn: null, promise: null };
globalThis.__mongooseCache = cached;

export async function ensureDB(): Promise<typeof mongoose> {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    cached.promise = mongoose.connect(MONGODB_URI).then((m) => {
      cached.conn = m;
      return m;
    });
  }

  return cached.promise;
}
