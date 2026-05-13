export const GOOGLE_REQUEST_TIMEOUT_MS = 30_000;

export type GoogleProvider = "gmail" | "gcal";

export class GoogleRequestTimeoutError extends Error {
  provider: GoogleProvider;
  code: `${GoogleProvider}_request_timeout`;

  constructor(provider: GoogleProvider) {
    super(`${provider}_request_timeout`);
    this.name = "GoogleRequestTimeoutError";
    this.provider = provider;
    this.code = `${provider}_request_timeout`;
  }
}

export function isAbortSignalTimeout(err: unknown): boolean {
  if (!(err && typeof err === "object" && "name" in err)) return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}
