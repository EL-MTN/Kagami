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

import { z } from "zod";

// KAO_API_URL is rendered into anchor hrefs (oauthStartUrl) as well as used
// as the fetch base, so an http(s) URL is enforced eagerly at module load.
// KAO_TOKEN can't be validated eagerly because Next.js evaluates this module
// during `next build` (when the env may be intentionally absent); see
// `requireToken` below for the lazy check at request time. An empty string is
// treated as 'unset' (matches the API's config.ts blankAsUndefined pattern),
// so `KAO_API_URL=` in .env falls back to the default instead of crashing.
const apiUrl = z
  .preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z
      .string()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), "KAO_API_URL must use http(s)")
      .default("https://api.kao.localhost"),
  )
  .parse(process.env.KAO_API_URL);

const API_URL = apiUrl.replace(/\/+$/, "");

// Default upper-bound on any single API hop. The sidebar's `/healthz` probe
// renders inside `RootLayout`, so a hung Kao without a timeout would stall
// every page navigation; this caps that wait.
const DEFAULT_TIMEOUT_MS = 5_000;

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

// Lazy at call time so `next build` can run without a KAO_TOKEN configured.
// Surfaces as a structured ApiError(0, …) so Server Actions can render the
// missing-config case inline rather than crashing into Next's default error
// overlay.
function requireToken(): string {
  const token = process.env.KAO_TOKEN;
  if (!token || token.trim().length < 16) {
    throw new ApiError(
      0,
      "KAO_TOKEN is not set in the dashboard's environment (or is too short). Copy apps/dashboard/.env.example and fill it with the same value the Kao API uses.",
      "misconfigured",
    );
  }
  return token;
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
  if (typeof inner !== "object" || inner === null) return false;
  // `code` and `message` are the only fields use-sites read as strings; verify
  // both so a malformed upstream response can't carry a non-string into
  // `new ApiError(status, inner.message, inner.code)`.
  const rec = inner as Record<string, unknown>;
  return typeof rec.code === "string" && typeof rec.message === "string";
}

interface CallOptions {
  // Default true. The bearer-gated /grants/* surface needs it; the open
  // /healthz probe must NOT pass it (otherwise a missing KAO_TOKEN would
  // surface as "API unreachable" instead of the real config error).
  auth?: boolean;
  timeoutMs?: number;
}

async function call<T>(method: string, path: string, opts: CallOptions = {}): Promise<T> {
  const { auth = true, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = `Bearer ${requireToken()}`;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
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
  status: string;
  service: string;
}

// ── Calls ──────────────────────────────────────────────────────
// Read endpoints — pulled from Server Components, so they live on the path
// `force-dynamic` covers; no caching layer here.

export async function getHealth(): Promise<HealthResponse> {
  // /healthz is open at localhost — explicitly skip the bearer so a missing
  // KAO_TOKEN doesn't surface as "API unreachable" in the sidebar. Shorter
  // timeout because this probe runs in the layout shell on every navigation.
  return call<HealthResponse>("GET", "/healthz", { auth: false, timeoutMs: 2_000 });
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
