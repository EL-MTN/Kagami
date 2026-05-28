import type { Config } from "../config.js";
import { tracedFetch } from "@kagami/logger/traced-fetch";
import { logger } from "./logger.js";

// Thin HTTP client for the Kao identity service. Kizuna no longer owns a
// Google refresh token — it asks Kao for a fresh access token on demand. Kao
// itself caches with a 30s safety buffer, so back-to-back ingest calls almost
// always hit Kao's in-process cache; the short cache here adds a second
// short-circuit so a sync tick that hits Gmail + Calendar back-to-back
// doesn't even make a local HTTP round-trip per message.
//
// External boundary: Kao-specific errors are translated into Kizuna's
// existing `OAuthError` taxonomy on the way out so the ingest workers keep
// pausing/no-granting/erroring with the same shapes they always have.
//
// All four error classes set `this.name` so the `@kagami/logger` ECS
// serializer emits a useful `error.type` instead of the inherited "Error",
// which keeps Kansoku error fingerprinting from collapsing OAuth-pause
// events into the generic-Error bucket.

class KaoNoGrantError extends Error {
  readonly code: "no_grant" | "invalid_grant" | "decrypt_failed";
  constructor(code: "no_grant" | "invalid_grant" | "decrypt_failed", message: string) {
    super(message);
    this.name = "KaoNoGrantError";
    this.code = code;
  }
}

class KaoUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KaoUnreachableError";
  }
}

class KaoMisconfiguredError extends Error {
  // `code` distinguishes the two operator-actionable misconfig cases:
  //   - bad_bearer: KAO_TOKEN rejected (401)
  //   - wrong_host: 404 with a non-Kao response shape (KAO_URL likely points
  //     at the wrong service)
  // The translation to OAuthError uses this so the worker can record a
  // matching stable label and the dashboard's status reason can stay in
  // lockstep with the ingest path's lastError.
  readonly code: "bad_bearer" | "wrong_host";
  constructor(code: "bad_bearer" | "wrong_host", message: string) {
    super(message);
    this.name = "KaoMisconfiguredError";
    this.code = code;
  }
}

export class OAuthError extends Error {
  readonly code: "no_grant" | "invalid_grant" | "refresh_failed" | "kao_unauthorized";
  constructor(
    code: "no_grant" | "invalid_grant" | "refresh_failed" | "kao_unauthorized",
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
  }
}

interface Cached {
  token: string;
  expiresAt: number;
}
let cache: Cached | null = null;
// In-flight de-dup: concurrent callers on a cold cache share one HTTP call.
// Each ingest tick may call gmail + calendar back-to-back; without this,
// they'd each issue their own parallel vend before the first response cached.
let inflight: Promise<string> | null = null;

// Clear BOTH cache and inflight. Clearing only `cache` would leave a stale
// inflight (started before the clear) to overwrite `cache` with a stale
// result the moment it resolves — partially defeating the clear. The
// 401-retry path in the clients depends on this being a hard reset.
export function clearAccessTokenCache(): void {
  cache = null;
  inflight = null;
}

// 30s buffer matches Kao's own cache policy — both layers agree on
// "treat expiring-soon as expired" so a refresh stays comfortably ahead of
// any in-flight Google call.
const EXPIRY_BUFFER_MS = 30_000;
// Bound for the fetch round-trip. A hung Kao must not stall an ingest tick —
// surface as KaoUnreachableError instead. Kao's vend path is local in dev
// (Portless on the same host) and Kao itself caches refreshes, so the real
// budget is just the local HTTP + a possible Google round-trip.
const FETCH_TIMEOUT_MS = 5_000;
// An access token "expires" in seconds-to-an-hour. A returned expiresAt
// further out than this is almost certainly garbage and would pin a dead
// token until process restart — clamp to a sane upper bound.
const MAX_PLAUSIBLE_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Vend a Google access token via Kao. `force: true` instructs Kao to bypass
 * ITS in-process cache and round-trip to Google for a fresh token — the only
 * way to recover from a Google-side revocation mid-window. Without it, Kao's
 * 30 s-buffer cache would re-vend the dead token until its expiry lapses
 * (~the full token lifetime). The client wrappers in `ingest/{gmail,
 * calendar}-client.ts` retry once with `force:true` on a Google 401.
 *
 * `force` also resets the LOCAL inflight/cache here so the caller doesn't
 * piggyback an in-flight non-force fetch (which is using the stale token).
 *
 * Throws `OAuthError` only — Kao-specific error classes are kept internal so
 * the ingest workers keep matching on the existing taxonomy:
 *  - KaoNoGrantError(no_grant)       → OAuthError(no_grant)
 *  - KaoNoGrantError(invalid_grant)  → OAuthError(invalid_grant)
 *  - KaoNoGrantError(decrypt_failed) → OAuthError(invalid_grant)
 *  - KaoUnreachableError             → OAuthError(refresh_failed)
 *  - KaoMisconfiguredError           → OAuthError(refresh_failed)
 */
export async function getAccessToken(
  config: Config,
  options: { force?: boolean } = {},
): Promise<string> {
  if (options.force) {
    cache = null;
    inflight = null;
  } else {
    if (cache && cache.expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
      return cache.token;
    }
    if (inflight) return inflight;
  }

  if (!config.KAO_URL || !config.KAO_TOKEN) {
    throw new OAuthError(
      "refresh_failed",
      "KAO_URL and KAO_TOKEN must both be set to vend Google access tokens via Kao",
    );
  }

  const base = config.KAO_URL.replace(/\/+$/, "");
  const url = `${base}/grants/kizuna/token${options.force ? "?force=1" : ""}`;
  const bearer = config.KAO_TOKEN;

  // Race-safety: only the currently-registered inflight writes back into
  // `cache` and clears the `inflight` slot. A stale inflight (one whose slot
  // was already replaced by a force-refresh or a clear) still resolves its
  // own awaiters but does not touch shared state — so it can't overwrite a
  // newer fresh token in `cache`, and it can't null out a newer inflight.
  let p: Promise<string> | undefined = undefined;
  p = (async () => {
    try {
      const vended = await fetchToken(url, bearer, base);
      if (inflight === p) {
        cache = { token: vended.accessToken, expiresAt: vended.expiresAt };
      }
      return vended.accessToken;
    } catch (err) {
      // Translate Kao taxonomy → Kizuna's OAuthError so the ingest workers
      // keep matching on stable error codes.
      if (err instanceof KaoNoGrantError) {
        if (err.code === "no_grant") {
          throw new OAuthError("no_grant", err.message);
        }
        // decrypt_failed and invalid_grant both require operator re-consent.
        throw new OAuthError("invalid_grant", err.message);
      }
      if (err instanceof KaoMisconfiguredError) {
        // bad_bearer (Kao 401) gets a distinct OAuthError code so the worker
        // can record `kao_unauthorized` in lastError — matching the status
        // route's `reason: "kao_unauthorized"`. Otherwise the operator
        // would see "Kao rejected our bearer" on the OAuth card AND
        // "kao_unreachable" on the Gmail/Calendar card simultaneously
        // for the same single root cause.
        if (err.code === "bad_bearer") {
          throw new OAuthError("kao_unauthorized", err.message);
        }
        throw new OAuthError("refresh_failed", err.message);
      }
      if (err instanceof KaoUnreachableError) {
        throw new OAuthError("refresh_failed", err.message);
      }
      throw err;
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
    // tracedFetch propagates the active W3C traceparent so Kao's
    // traceMiddleware threads the vend call onto the same trace as the
    // request (or scheduler tick) that triggered ingest — observability
    // across the Kizuna→Kao hop in Kansoku.
    res = await tracedFetch(url, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // AbortError from the timeout, network failure, DNS, etc. all surface
    // as KaoUnreachableError — the caller treats them identically.
    throw new KaoUnreachableError(`Kao token fetch failed: ${msg}`);
  }

  if (res.status === 401) {
    // Bearer wrong — operator config error, not transient. Surface plainly.
    throw new KaoMisconfiguredError(
      "bad_bearer",
      `Kao returned 401 for grants/kizuna/token — check KAO_TOKEN`,
    );
  }

  if (res.status === 404) {
    // Distinguish "Kao itself said this grant is unregistered" from "wrong
    // host happens to 404 every path". A Kao 404 carries a JSON envelope
    // `{ error: { code: "not_found", message } }` (kao/apps/api/src/lib/
    // errors.ts). A wrong-host 404 typically responds with text/html, plain
    // text, or a different JSON shape — those should surface as a
    // misconfiguration, not silently idle as no_grant.
    //
    // Exact-match on the media type rather than substring `includes` so we
    // don't accidentally treat `application/ld+json` or
    // `application/vnd.api+json` as Kao. The `; charset=utf-8` parameter
    // suffix from Express's `res.json` is normalized by splitting on `;`.
    const ct = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const looksJson = ct === "application/json";
    const body = looksJson ? ((await res.json().catch(() => null)) as unknown) : null;
    // Kao's real 404 envelope (kao/apps/api/src/lib/errors.ts) always carries
    // `error.code: "not_found"` as a string. Requiring `error.code` to be a
    // string distinguishes Kao from look-alike envelopes — e.g. a Next.js
    // catch-all that 404s with `{error: {message: "..."}}` (no `code`) or
    // some other JSON API with `{error: {detail: "..."}}`. Without this
    // gate, a typo'd KAO_URL pointing at any JSON service with an `error`
    // object would silently route to no_grant, and (since recordIdleRun
    // clears lastError every tick) the operator would have zero diagnostic
    // surface for the misconfig.
    const errorField =
      body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      "error" in (body as Record<string, unknown>)
        ? (body as { error?: unknown }).error
        : undefined;
    const isKaoEnvelope =
      typeof errorField === "object" &&
      errorField !== null &&
      !Array.isArray(errorField) &&
      typeof (errorField as { code?: unknown }).code === "string";
    if (isKaoEnvelope) {
      // Kao confirmed: grant unknown to it (not in GRANT_NAMES yet, or
      // operator hasn't registered 'kizuna'). Idle cleanly via no_grant.
      throw new KaoNoGrantError(
        "no_grant",
        `Kao has no 'kizuna' grant — consent at ${base}/oauth/kizuna/start`,
      );
    }
    // 404 from something that doesn't look like Kao — likely a typo'd
    // KAO_URL pointing at the wrong service. Surface as misconfig so the
    // operator sees an actionable error instead of "Connect Google".
    throw new KaoMisconfiguredError(
      "wrong_host",
      `Kao returned 404 with a non-Kao response body — check KAO_URL points at Kao`,
    );
  }

  if (res.status === 409) {
    // Either no consent yet, Google rejected the refresh, or the stored
    // refresh token can't be decrypted (key rotated / ciphertext corruption).
    // All three require the operator to (re-)consent at
    // ${KAO_URL}/oauth/kizuna/start, but the structured code lets a caller
    // distinguish them.
    //
    // The `.catch(() => null)` covers JSON.parse failure; the `?? {}` then
    // covers the case where the body is the literal JSON `null` (valid JSON,
    // `res.json()` resolves to `null`) — without the second guard, the
    // subsequent `body.error?.details?.code` would dereference null and
    // raise an untranslated TypeError that escapes the IIFE.
    const raw = (await res.json().catch(() => null)) as unknown;
    const body = (raw && typeof raw === "object" ? raw : {}) as {
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
      `Kao: ${code} for grant 'kizuna' — consent at ${base}/oauth/kizuna/start`,
    );
  }

  if (!res.ok) {
    throw new KaoUnreachableError(`Kao returned ${res.status} for grants/kizuna/token`);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new KaoUnreachableError(`Kao returned malformed JSON: ${msg}`);
  }
  if (data === null || typeof data !== "object") {
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

  logger.debug(
    { expiresAt: new Date(expiresAt).toISOString() },
    "fetched google access token from kao",
  );
  return { accessToken, expiresAt };
}

// Strict ISO-8601 datetime regex (date + time component + timezone). A
// bare date like "1970-01-01" passes `new Date(s).getTime()` (returns 0,
// finite) but renders as "Dec 31, 1969, 7:00 PM" in the dashboard's
// non-UTC timezone — exactly the misleading concrete date the null
// fallback aims to prevent. Require the `T` + time + tz so only real
// timestamps survive the validation.
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

// Fetch the grant status from Kao for the OAuth status route. Returns the
// reshape the dashboard already expects; absence/missing-config yields
// `{ granted: false }` rather than throwing — the dashboard's UX is
// "Connect Google" in that case. grantedAt may be `null` (Kao said the
// grant works but didn't supply a parseable timestamp); the dashboard
// renders that as "timestamp unknown" instead of a misleading concrete
// date.
//
// `reason` is a hint for the dashboard to render a more specific message
// than the default "Connect Google" — primarily so an operator with a
// wrong KAO_TOKEN isn't stuck clicking Connect forever.
export async function fetchGrantStatus(config: Config): Promise<
  | { granted: false; reason?: "kao_unauthorized" | "kao_unreachable" }
  | {
      granted: true;
      scopes: string[];
      grantedAt: string | null;
    }
> {
  if (!config.KAO_URL || !config.KAO_TOKEN) {
    return { granted: false };
  }
  const base = config.KAO_URL.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await tracedFetch(`${base}/grants/kizuna`, {
      headers: { Authorization: `Bearer ${config.KAO_TOKEN}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ error: err }, "kao grant status fetch failed");
    return { granted: false, reason: "kao_unreachable" };
  }
  if (!res.ok) {
    if (res.status === 401) {
      // Bearer rejected — operator config error, not "no consent yet".
      // Surface a distinct reason so the dashboard can hint at the actual
      // fix rather than offering "Connect Google" which won't help.
      logger.warn({ status: 401 }, "kao grant status: bearer rejected — check KAO_TOKEN");
      return { granted: false, reason: "kao_unauthorized" };
    }
    // For 4xx (other than 401) include the response body so the operator
    // can distinguish "Kao API contract changed" (e.g. /grants/:grant moved)
    // from a transient blip. 4xx → error level (not transient); 5xx stays
    // at warn (transient). Body truncated to 500 chars.
    const body = await res.text().catch(() => "<unreadable>");
    const isClientError = res.status >= 400 && res.status < 500;
    if (isClientError) {
      logger.error(
        { status: res.status, body: body.slice(0, 500) },
        "kao grant status returned 4xx — possible API contract change",
      );
    } else {
      logger.warn({ status: res.status }, "kao grant status returned 5xx");
    }
    return { granted: false, reason: "kao_unreachable" };
  }
  const data = (await res.json().catch(() => null)) as {
    granted?: boolean;
    scopes?: string[];
    grantedAt?: string | null;
  } | null;
  // Strict-equal `=== true` rejects truthy non-booleans (Kao API drift /
  // serialization bug returning "yes" / 1 would otherwise route to the
  // granted branch and mask a real Kao contract issue as a working grant).
  if (!data || data.granted !== true) {
    if (data && data.granted !== undefined && data.granted !== false) {
      // Surface the drift loudly — silently flipping to "Connect Google"
      // hides a contract issue.
      logger.warn(
        { granted: data.granted },
        "kao returned non-boolean granted; treating as not granted",
      );
    }
    return { granted: false };
  }
  // Surface null grantedAt rather than a fake epoch sentinel. The dashboard
  // renders that distinctly from a real date. Both checks are needed:
  //   - ISO_DATETIME_RE rejects date-only strings like "1970-01-01" that
  //     `new Date` would happily parse (and render as "Dec 31, 1969").
  //   - Number.isFinite(new Date(s).getTime()) rejects shape-valid but
  //     semantically-invalid strings like "2026-13-45T25:99:99Z" that the
  //     regex's \d{2} accepts but Date returns NaN for. Without this check
  //     the dashboard would render "on —" (fmtDateTime's NaN fallback)
  //     instead of the intended "timestamp unknown" branch.
  const rawGrantedAt = data.grantedAt;
  const grantedAt =
    typeof rawGrantedAt === "string" &&
    ISO_DATETIME_RE.test(rawGrantedAt) &&
    Number.isFinite(new Date(rawGrantedAt).getTime())
      ? rawGrantedAt
      : null;
  return {
    granted: true,
    scopes: Array.isArray(data.scopes) ? data.scopes.filter((s) => typeof s === "string") : [],
    grantedAt,
  };
}
