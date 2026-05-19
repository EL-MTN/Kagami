import { config, logger, tracedFetch } from "@kokoro/shared";

// Thin HTTP client for the Kao identity service. Kokoro no longer owns a
// Google refresh token — it asks Kao for a fresh access token on demand.
// Kao itself caches with a 30s safety buffer, so back-to-back Kokoro calls
// almost always hit Kao's in-process cache; the cache here adds a second
// short-circuit so an LLM turn that hits Gmail + Calendar back-to-back
// doesn't even make a local HTTP round-trip.

export class KaoNoGrantError extends Error {
  readonly code: "no_grant" | "invalid_grant";
  constructor(code: "no_grant" | "invalid_grant", message: string) {
    super(message);
    this.code = code;
  }
}

export class KaoUnreachableError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class KaoMisconfiguredError extends Error {
  constructor(message: string) {
    super(message);
  }
}

interface Cached {
  token: string;
  expiresAt: number;
}
let cache: Cached | null = null;
// In-flight de-dup: concurrent callers on a cold cache share one HTTP call
// instead of each firing their own (a single LLM turn can call gmail +
// calendar back-to-back; without this they'd issue two parallel vends).
let inflight: Promise<VendedAccessToken> | null = null;

export function clearAccessTokenCache(): void {
  cache = null;
}

export interface VendedAccessToken {
  accessToken: string;
  expiresAt: number;
}

// 30s buffer matches Kao's own cache policy — both layers agree on "treat
// expiring-soon as expired" so a refresh stays comfortably ahead of any
// in-flight request.
const EXPIRY_BUFFER_MS = 30_000;
// Bound for the fetch round-trip. A hung Kao must not stall an LLM turn —
// surface as KaoUnreachableError instead. Kao's vend path is local in dev
// (Portless on the same host) and Kao itself caches refreshes, so the real
// budget is just the local HTTP + a possible Google round-trip — 5s is
// generous.
const FETCH_TIMEOUT_MS = 5_000;
// An access token "expires" in seconds-to-an-hour. A returned expiresAt
// further out than this is almost certainly garbage and would pin a dead
// token until process restart — clamp to a sane upper bound.
const MAX_PLAUSIBLE_EXPIRY_MS = 24 * 60 * 60 * 1000;

export async function getAccessToken(): Promise<VendedAccessToken> {
  if (cache && cache.expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
    return { accessToken: cache.token, expiresAt: cache.expiresAt };
  }
  if (inflight) return inflight;

  if (!config.KAO_URL || !config.KAO_TOKEN) {
    throw new KaoMisconfiguredError(
      "KAO_URL and KAO_TOKEN must both be set to use Google services via Kao",
    );
  }

  const base = config.KAO_URL.replace(/\/+$/, "");
  const url = `${base}/grants/kokoro/token`;
  const bearer = config.KAO_TOKEN;

  inflight = (async () => {
    try {
      return await fetchAndCache(url, bearer, base);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function fetchAndCache(
  url: string,
  bearer: string,
  base: string,
): Promise<VendedAccessToken> {
  let res: Response;
  try {
    res = await tracedFetch(url, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // AbortError from the timeout, network failure, DNS, etc. all surface as
    // KaoUnreachableError — the caller treats them identically (transient).
    throw new KaoUnreachableError(`Kao token fetch failed: ${msg}`);
  }

  if (res.status === 401 || res.status === 404) {
    // Bearer wrong or grant name unknown to Kao — operator config error,
    // not a transient one. Surface plainly; do not cache.
    throw new KaoMisconfiguredError(
      `Kao returned ${res.status} for grants/kokoro/token — check KAO_TOKEN and that the 'kokoro' grant is registered`,
    );
  }

  if (res.status === 409) {
    // Either no consent yet, or Google rejected the refresh. Both require
    // the operator to (re-)consent at ${KAO_URL}/oauth/kokoro/start.
    const body = (await res.json().catch(() => ({}))) as {
      error?: { details?: { code?: string } };
    };
    const code = body.error?.details?.code === "invalid_grant" ? "invalid_grant" : "no_grant";
    throw new KaoNoGrantError(
      code,
      `Kao: ${code} for grant 'kokoro' — consent at ${base}/oauth/kokoro/start`,
    );
  }

  if (!res.ok) {
    throw new KaoUnreachableError(`Kao returned ${res.status} for grants/kokoro/token`);
  }

  // Parse + validate the success body inside the same taxonomy. A 200 with a
  // malformed body must not escape as a generic SyntaxError.
  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new KaoUnreachableError(`Kao returned malformed JSON: ${msg}`);
  }
  const accessToken = (data as { accessToken?: unknown }).accessToken;
  const expiresAt = (data as { expiresAt?: unknown }).expiresAt;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new KaoUnreachableError("Kao returned no accessToken");
  }
  if (
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + MAX_PLAUSIBLE_EXPIRY_MS
  ) {
    // NaN / negative / past / wildly-future values would pin a dead token or
    // disable the cache entirely. Treat as unreachable and skip caching.
    throw new KaoUnreachableError(`Kao returned implausible expiresAt: ${String(expiresAt)}`);
  }

  cache = { token: accessToken, expiresAt };
  logger.debug(
    { expiresAt: new Date(expiresAt).toISOString() },
    "fetched google access token from Kao",
  );
  return { accessToken, expiresAt };
}
