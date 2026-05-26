import { tracedFetch } from "@kagami/logger/traced-fetch";
import type { Config } from "../config.js";
import { logger } from "./logger.js";

// Thin HTTP client for the Kao identity service. Kizuna no longer owns a
// Google refresh token — it asks Kao for a fresh access token on demand.
// Kao itself caches with a 30 s safety buffer, so back-to-back vends almost
// always hit Kao's in-process cache; the cache here adds a second short-circuit
// so a single ingest pass that hits Gmail + Calendar back-to-back doesn't even
// make a local HTTP round-trip per worker.
//
// `OAuthError` is preserved (same shape as the old `lib/google-auth.ts`)
// because `ingest/{gmail,calendar}.ts` branch on its `.code` to pause the
// SyncState on `invalid_grant` and report `no_grant` distinctly. Refactoring
// that taxonomy is out of scope; this module maps every Kao response into it.

export class OAuthError extends Error {
  readonly code: "no_grant" | "invalid_grant" | "refresh_failed";
  constructor(code: "no_grant" | "invalid_grant" | "refresh_failed", message: string) {
    super(message);
    this.code = code;
  }
}

interface Cached {
  token: string;
  expiresAt: number;
}
let cache: Cached | null = null;
// In-flight de-dup: concurrent callers on a cold cache share one HTTP call
// instead of each firing their own. A single ingest tick can run Gmail and
// Calendar back-to-back; without this they'd issue two parallel vends.
let inflight: Promise<string> | null = null;

// Clear BOTH cache and inflight. Clearing only `cache` would leave a stale
// inflight (started before the clear, e.g. before Google revoked the token)
// to overwrite `cache` with a stale result the moment it resolves — partially
// defeating the clear. The force-refresh path depends on this being a hard
// reset.
export function clearAccessTokenCache(): void {
  cache = null;
  inflight = null;
}

// 30 s buffer matches Kao's own cache policy — both layers agree on
// "treat expiring-soon as expired" so a refresh stays comfortably ahead of any
// in-flight Gmail/Calendar request.
const EXPIRY_BUFFER_MS = 30_000;
// Bound for the local fetch round-trip. A hung Kao must not stall an ingest
// pass — surface as `refresh_failed` instead. Kao's vend path is local in dev
// (Portless on the same host) and Kao itself caches refreshes, so the real
// budget is just the local HTTP + a possible Google round-trip; 5 s is
// generous.
const FETCH_TIMEOUT_MS = 5_000;
// An access token "expires" in seconds-to-an-hour. A returned expiresAt
// further out than this is almost certainly garbage and would pin a dead token
// until process restart — clamp by treating it as unreachable.
const MAX_PLAUSIBLE_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Vend a Google access token via Kao. `force: true` clears the local cache
 * and instructs Kao to bypass its own cache (round-trip to Google) — the only
 * way to recover from a mid-window Google revocation. Without it, both caches
 * would re-vend the dead token until its expiry lapses (~the full lifetime).
 *
 * Returned as a bare string to preserve the seam the ingest workers were
 * already coded against (`() => Promise<string>` injected into the Gmail and
 * Calendar clients).
 */
export async function getAccessToken(
  config: Config,
  opts: { force?: boolean } = {},
): Promise<string> {
  if (opts.force) {
    cache = null;
    inflight = null;
  } else {
    if (cache && cache.expiresAt > Date.now() + EXPIRY_BUFFER_MS) return cache.token;
    if (inflight) return inflight;
  }

  if (!config.KAO_TOKEN) {
    // KAO_URL has a default but KAO_TOKEN is a secret with no default. Without
    // it we can't authenticate against Kao at all; surface as `refresh_failed`
    // so the worker records it as a sync error (vs. pausing).
    throw new OAuthError(
      "refresh_failed",
      "KAO_TOKEN is not set — Kizuna cannot vend Google access tokens from Kao",
    );
  }

  const base = config.KAO_URL.replace(/\/+$/, "");
  const url = `${base}/grants/kizuna/token${opts.force ? "?force=1" : ""}`;
  const bearer = config.KAO_TOKEN;

  // Race-safety: only the currently-registered inflight writes back into
  // `cache` and clears the `inflight` slot. A stale inflight (one whose slot
  // was already replaced by a force-refresh or a clear) still resolves its own
  // awaiters but does not touch shared state — so it can't overwrite a newer
  // fresh token in `cache`, and it can't null out a newer inflight.
  let p: Promise<string> | undefined = undefined;
  p = (async () => {
    try {
      const vended = await fetchToken(url, bearer, base);
      if (inflight === p) cache = { token: vended.accessToken, expiresAt: vended.expiresAt };
      return vended.accessToken;
    } finally {
      if (inflight === p) inflight = null;
    }
  })();
  inflight = p;
  return p;
}

interface VendedAccessToken {
  accessToken: string;
  expiresAt: number;
}

async function fetchToken(url: string, bearer: string, base: string): Promise<VendedAccessToken> {
  let res: Response;
  try {
    res = await tracedFetch(url, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // AbortError from the timeout, network failure, DNS, etc. all surface as
    // refresh_failed — the worker treats them as a sync error (not paused),
    // so the next scheduled tick will retry.
    const msg = err instanceof Error ? err.message : String(err);
    throw new OAuthError("refresh_failed", `Kao unreachable: ${msg}`);
  }

  if (res.status === 401) {
    throw new OAuthError(
      "refresh_failed",
      "Kao rejected bearer (401) — check KAO_TOKEN matches Kao's KAO_TOKEN",
    );
  }
  if (res.status === 404) {
    throw new OAuthError(
      "refresh_failed",
      "Kao does not know grant 'kizuna' (404) — check Kao's grant-registry.ts",
    );
  }

  if (res.status === 409) {
    // Kao distinguishes the three "needs re-consent" causes via the structured
    // details code. `invalid_grant` and `decrypt_failed` both require the
    // operator to re-consent at Kao (decrypt failure is fixed by writing a
    // fresh ciphertext under the current key) — map both to `invalid_grant`
    // so the worker pauses and prints the actionable "re-grant required"
    // message. `no_grant` is a distinct first-time state.
    const body = (await res.json().catch(() => ({}))) as {
      error?: { details?: { code?: string } };
    };
    const detailsCode = body.error?.details?.code;
    const consentUrl = `${base}/oauth/kizuna/start`;
    if (detailsCode === "invalid_grant") {
      throw new OAuthError(
        "invalid_grant",
        `Kao: invalid_grant for 'kizuna' — re-consent at ${consentUrl}`,
      );
    }
    if (detailsCode === "decrypt_failed") {
      throw new OAuthError(
        "invalid_grant",
        `Kao: decrypt_failed for 'kizuna' — re-consent at ${consentUrl} to write a fresh ciphertext`,
      );
    }
    throw new OAuthError("no_grant", `Kao: no grant for 'kizuna' — consent at ${consentUrl}`);
  }

  if (res.status === 502) {
    // Transient Google-side refresh failure. Surface as `refresh_failed` so
    // the worker logs an error and the next tick retries (Kao itself didn't
    // cache a dead value).
    throw new OAuthError("refresh_failed", `Kao: upstream Google refresh failed (502)`);
  }

  if (!res.ok) {
    throw new OAuthError("refresh_failed", `Kao returned unexpected status ${res.status}`);
  }

  // Parse + validate the success body inside the same taxonomy. A 200 with a
  // malformed body must not escape as a generic SyntaxError.
  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OAuthError("refresh_failed", `Kao returned malformed JSON: ${msg}`);
  }
  if (data === null || typeof data !== "object") {
    throw new OAuthError("refresh_failed", "Kao returned a non-object body");
  }
  const accessToken = (data as { accessToken?: unknown }).accessToken;
  const expiresAt = (data as { expiresAt?: unknown }).expiresAt;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new OAuthError("refresh_failed", "Kao returned no accessToken");
  }
  if (
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + MAX_PLAUSIBLE_EXPIRY_MS
  ) {
    // NaN / negative / past / wildly-future values would pin a dead token or
    // disable the cache entirely. Treat as refresh_failed and skip caching.
    throw new OAuthError(
      "refresh_failed",
      `Kao returned implausible expiresAt: ${String(expiresAt)}`,
    );
  }

  // Cache write happens in the caller (getAccessToken) gated on
  // `inflight === p` so a stale inflight resolving after a force-refresh
  // can't overwrite the fresh value in `cache`.
  logger.debug(
    { expiresAt: new Date(expiresAt).toISOString() },
    "fetched google access token from kao",
  );
  return { accessToken, expiresAt };
}
