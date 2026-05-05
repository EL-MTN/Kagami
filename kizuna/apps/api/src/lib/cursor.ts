import { errors } from "./errors.js";

// Cursors are opaque base64url-encoded JSON. Each list endpoint defines
// the shape of its cursor payload (e.g. {id} or {lia, id}).

export function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor<T>(cursor: string): T {
  let json: unknown;
  try {
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    json = JSON.parse(text);
  } catch {
    throw errors.badRequest("invalid cursor");
  }
  if (json === null || typeof json !== "object") {
    throw errors.badRequest("invalid cursor");
  }
  return json as T;
}
