import { config, logger, tracedFetch } from "@kokoro/shared";

// Thin HTTP client for the Kao identity service. Kokoro no longer owns a
// Google refresh token — it asks Kao for a fresh access token on demand.
// Kao itself caches with a 30s safety buffer, so back-to-back Kokoro calls
// almost always hit Kao's in-process cache; the cache here adds a second
// short-circuit so an LLM turn that hits Gmail + Calendar back-to-back
// doesn't even make a local HTTP round-trip.

export class KaoNoGrantError extends Error {
  readonly code: "no_grant" | "invalid_grant" | "decrypt_failed";
  constructor(code: "no_grant" | "invalid_grant" | "decrypt_failed", message: string) {
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

// Clear BOTH cache and inflight. Clearing only `cache` would leave a stale
// inflight (started before the clear, e.g. before Google revoked the token)
// to overwrite `cache` with a stale result the moment it resolves —
// partially defeating the clear. The withFreshAuth retry path depends on
// this being a hard reset.
export function clearAccessTokenCache(): void {
  cache = null;
  inflight = null;
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

/**
 * Vend an access token. `force: true` instructs Kao to bypass its own
 * in-process cache and round-trip to Google for a fresh token — the only
 * way to recover from a Google-side revocation mid-window. Without it,
 * Kao's 30s-buffer cache would re-vend the dead token until its expiry
 * lapses (~the full token lifetime).
 *
 * `force` also resets the LOCAL inflight/cache here so the caller doesn't
 * piggyback an in-flight non-force fetch (which is using the stale token).
 */
export async function getAccessToken(
  options: { force?: boolean } = {},
): Promise<VendedAccessToken> {
  if (options.force) {
    cache = null;
    inflight = null;
  } else {
    if (cache && cache.expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
      return { accessToken: cache.token, expiresAt: cache.expiresAt };
    }
    if (inflight) return inflight;
  }

  if (!config.KAO_URL || !config.KAO_TOKEN) {
    throw new KaoMisconfiguredError(
      "KAO_URL and KAO_TOKEN must both be set to use Google services via Kao",
    );
  }

  const base = config.KAO_URL.replace(/\/+$/, "");
  const url = `${base}/grants/kokoro/token${options.force ? "?force=1" : ""}`;
  const bearer = config.KAO_TOKEN;

  // Race-safety: only the currently-registered inflight writes back into
  // `cache` and clears the `inflight` slot. A stale inflight (one whose slot
  // was already replaced by a force-refresh or a clear) still resolves its
  // own awaiters but does not touch shared state — so it can't overwrite a
  // newer fresh token in `cache`, and it can't null out a newer inflight.
  let p: Promise<VendedAccessToken> | undefined = undefined;
  p = (async () => {
    try {
      const vended = await fetchToken(url, bearer);
      if (inflight === p) {
        cache = { token: vended.accessToken, expiresAt: vended.expiresAt };
      }
      return vended;
    } finally {
      if (inflight === p) inflight = null;
    }
  })();
  inflight = p;
  return p;
}

async function fetchToken(url: string, bearer: string): Promise<VendedAccessToken> {
  const base = url.split("/grants/")[0] ?? url;
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
    // Either no consent yet, Google rejected the refresh, or the stored
    // refresh token can't be decrypted (key rotated / ciphertext corruption).
    // All three require the operator to (re-)consent at
    // ${KAO_URL}/oauth/kokoro/start, but the structured code lets a caller
    // distinguish them.
    const body = (await res.json().catch(() => ({}))) as {
      error?: { details?: { code?: string } };
    };
    const detailsCode = body.error?.details?.code;
    const code: "no_grant" | "invalid_grant" | "decrypt_failed" =
      detailsCode === "invalid_grant"
        ? "invalid_grant"
        : detailsCode === "decrypt_failed"
          ? "decrypt_failed"
          : "no_grant";
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
  if (data === null || typeof data !== "object") {
    // `res.json()` happily resolves to `null` for a literal JSON `null` body;
    // the subsequent property reads would throw TypeError outside taxonomy.
    throw new KaoUnreachableError("Kao returned a non-object body");
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

  // Note: cache write happens in the caller (getAccessToken) gated on
  // `inflight === p` so a stale inflight resolving after a force-refresh
  // can't overwrite the fresh value in `cache`.
  logger.debug(
    { expiresAt: new Date(expiresAt).toISOString() },
    "fetched google access token from Kao",
  );
  return { accessToken, expiresAt };
}
