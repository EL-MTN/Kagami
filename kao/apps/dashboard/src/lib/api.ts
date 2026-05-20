// Server-side Kao API client. Every /grants/* call is bearer-gated, and the
// bearer (KAO_TOKEN) lives in the dashboard's own .env. Calls run from React
// Server Components and Server Actions only — the bearer never reaches the
// browser. The "use server" directive on the action files keeps the surface
// invocable from the client without the secret crossing the wire.
//
// The OAuth start URL (/oauth/:grant/start) is intentionally NOT proxied: the
// operator clicks a plain anchor that takes their browser straight to the API
// origin, which 302s to Google. No bearer is needed there (CSRF state defends
// the route), and the redirect chain has to happen in the user's browser to
// land them on Google.

const API_URL = process.env.KAO_API_URL ?? "https://api.kao.localhost";

function bearer(): string {
  const token = process.env.KAO_TOKEN;
  if (!token || token.trim().length === 0) {
    throw new ApiError(
      0,
      "KAO_TOKEN is not set in the dashboard's environment — copy apps/dashboard/.env.example and fill it with the same value the Kao API uses.",
    );
  }
  return token;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Wire shape of Kao's error envelope (lib/errors.ts). The vend route carries a
// nested `details.code` (`no_grant` / `invalid_grant` / `decrypt_failed`) that
// the operator UI surfaces verbatim — narrowing happens at use-site below.
interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}

function isEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  // After the `in` check TS narrows `value` to include `error: unknown` — no cast needed.
  const inner = value.error;
  return typeof inner === "object" && inner !== null;
}

async function call<T>(method: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer()}`,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
    ...init,
  });

  if (!res.ok) {
    let envelope: unknown = undefined;
    try {
      envelope = await res.json();
    } catch {
      // body wasn't JSON; fall through to a status-only error
    }
    if (isEnvelope(envelope)) {
      const inner = envelope.error;
      const innerCode =
        inner.details &&
        typeof inner.details === "object" &&
        "code" in (inner.details as Record<string, unknown>)
          ? (inner.details as { code?: string }).code
          : undefined;
      throw new ApiError(res.status, inner.message, innerCode ?? inner.code, inner.details);
    }
    throw new ApiError(res.status, `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ── Public shapes ─────────────────────────────────────────────
// Dates are JSON-stringified across the wire; we keep them as `string`
// (ISO 8601) on the dashboard side and let `formatDateTime` / `formatRelative`
// turn them into rendered output. epochMs for `expiresAt` stays a number.

export interface GrantStatus {
  name: string;
  scopes: string[];
  granted: boolean;
  grantedAt: string | null;
  revokedAt: string | null;
}

export interface VendedToken {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
}

export interface RevokeResult {
  revoked: true;
  grant: string;
}

export interface HealthResponse {
  status: "ok";
  service: string;
}

// ── Calls ──────────────────────────────────────────────────────
// Read endpoints — pulled from Server Components, so they live on the path
// `force-dynamic` covers; no caching layer here.

export async function getHealth(): Promise<HealthResponse> {
  // /healthz is open at localhost, but going through `call` keeps the error
  // shape uniform with the bearer-gated endpoints — operators don't get a
  // surprise plain-error on this one.
  return call<HealthResponse>("GET", "/healthz");
}

export async function listGrants(): Promise<GrantStatus[]> {
  const res = await call<{ grants: GrantStatus[] }>("GET", "/grants");
  return res.grants;
}

export async function getGrant(name: string): Promise<GrantStatus> {
  return call<GrantStatus>("GET", `/grants/${encodeURIComponent(name)}`);
}

export async function vendToken(name: string): Promise<VendedToken> {
  // `force=1` bypasses Kao's in-process access-token cache so the probe
  // genuinely round-trips to Google. Without it, a stuck/dead grant could
  // re-vend a cached access token and look fine until it 401s in production.
  return call<VendedToken>("GET", `/grants/${encodeURIComponent(name)}/token?force=1`);
}

export async function revokeGrant(name: string): Promise<RevokeResult> {
  return call<RevokeResult>("DELETE", `/grants/${encodeURIComponent(name)}`);
}

// ── Browser-facing helpers (no bearer needed) ──────────────────
// These produce URLs the operator's browser navigates to directly. The /oauth
// surface is open@localhost (defended by HMAC-signed CSRF state); the browser
// must reach the API origin itself so the redirect chain to Google works.

export function oauthStartUrl(grant: string): string {
  return `${API_URL}/oauth/${encodeURIComponent(grant)}/start`;
}

export const KAO_API_BASE = API_URL;
