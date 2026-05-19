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

export async function getAccessToken(): Promise<VendedAccessToken> {
  if (cache && cache.expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
    return { accessToken: cache.token, expiresAt: cache.expiresAt };
  }

  if (!config.KAO_URL || !config.KAO_TOKEN) {
    throw new KaoMisconfiguredError(
      "KAO_URL and KAO_TOKEN must both be set to use Google services via Kao",
    );
  }

  const base = config.KAO_URL.replace(/\/+$/, "");
  const url = `${base}/grants/kokoro/token`;
  let res: Response;
  try {
    res = await tracedFetch(url, {
      headers: { Authorization: `Bearer ${config.KAO_TOKEN}` },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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

  const data = (await res.json()) as {
    accessToken: string;
    expiresAt: number;
    scopes?: string[];
  };
  if (!data.accessToken || typeof data.expiresAt !== "number") {
    throw new KaoUnreachableError("Kao returned malformed token payload");
  }
  cache = { token: data.accessToken, expiresAt: data.expiresAt };
  logger.debug(
    { expiresAt: new Date(data.expiresAt).toISOString() },
    "fetched google access token from Kao",
  );
  return { accessToken: data.accessToken, expiresAt: data.expiresAt };
}
