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
// as the fetch base. Enforce the same origin-only shape the API's config.ts
// uses for KAO_PUBLIC_URL/KAO_DASHBOARD_URL — both sides of the contract
// agree, so composition like `${API_URL}/grants/...` can't produce a
// malformed href if someone configures a stray path/query. KAO_TOKEN can't be
// validated eagerly because Next.js evaluates this module during `next build`
// (when the env may be intentionally absent); see `requireToken` below for
// the lazy check at request time. An empty string is treated as 'unset' so
// `KAO_API_URL=` in .env falls back to the default instead of crashing.
const apiUrl = z
  .preprocess(
    (v) => {
      if (typeof v !== "string") return v;
      const trimmed = v.trim();
      return trimmed === "" ? undefined : trimmed;
    },
    z
      .string()
      .url()
      .refine((u) => {
        try {
          const parsed = new URL(u);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
          if (parsed.search !== "" || parsed.hash !== "") return false;
          if (parsed.pathname !== "/") return false;
          return true;
        } catch {
          return false;
        }
      }, "KAO_API_URL must be an http(s) origin with no path/query/fragment")
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
// overlay. Trim before AND after the length check: the API's loadConfig
// trims the bearer it stores (blankAsUndefined), so an operator who pasted
// whitespace into apps/dashboard/.env would otherwise send a header with
// leading/trailing spaces and silently 401 every /grants/* request.
function requireToken(): string {
  const trimmed = process.env.KAO_TOKEN?.trim() ?? "";
  if (trimmed.length < 16) {
    throw new ApiError(
      0,
      "KAO_TOKEN is not set in the dashboard's environment (or is too short). Copy apps/dashboard/.env.example and fill it with the same value the Kao API uses.",
      "misconfigured",
    );
  }
  return trimmed;
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
      // Vend route puts the actionable code inside details.code
      // (no_grant / invalid_grant / decrypt_failed); promote it to
      // ApiError.code only when it's actually a string, so a malformed
      // future envelope can't slip a non-string into the typed surface.
      let innerCode: string | undefined;
      if (inner.details && typeof inner.details === "object") {
        const maybe = (inner.details as Record<string, unknown>).code;
        if (typeof maybe === "string") innerCode = maybe;
      }
      throw new ApiError(res.status, inner.message, innerCode ?? inner.code, inner.details);
    }
    throw new ApiError(res.status, `${res.status} ${res.statusText}`);
  }
  // A 200 with a non-JSON body (e.g. an HTML page from a misbehaving reverse
  // proxy) would otherwise surface as a raw SyntaxError — wrap it into the
  // same ApiError shape every caller already handles.
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(res.status, "API returned a non-JSON response body", "malformed_response");
  }
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
  // Defend the page render: a malformed 200 like `{}` would crash
  // `grants.map(...)` outside the page's try/catch, falling through to
  // Next's default error overlay instead of the structured ErrorBlock.
  if (!Array.isArray(res.grants)) {
    throw new ApiError(200, "API returned /grants without a grants[] array", "malformed_response");
  }
  return res.grants;
}

export async function getGrant(name: string): Promise<GrantStatus> {
  const res = await call<GrantStatus>("GET", `/grants/${encodeURIComponent(name)}`);
  // Parity with listGrants: defend the page render against a malformed 200
  // (missing scopes array, non-string name) so the detail page lands in the
  // structured catch instead of Next's default error overlay.
  if (
    !res ||
    typeof res !== "object" ||
    typeof res.name !== "string" ||
    !Array.isArray(res.scopes)
  ) {
    throw new ApiError(200, "API returned a grant with an unexpected shape", "malformed_response");
  }
  return res;
}

export async function vendToken(name: string): Promise<VendedToken> {
  // `force=1` bypasses Kao's in-process access-token cache so the probe
  // genuinely round-trips to Google. Without it, a stuck/dead grant could
  // re-vend a cached access token and look fine until it 401s in production.
  const res = await call<VendedToken>("GET", `/grants/${encodeURIComponent(name)}/token?force=1`);
  // Parity with listGrants/getGrant: a malformed 200 here would flow into
  // ProbeSuccess where maskToken(accessToken) and scopes.map() would crash
  // outside the action's try/catch.
  if (
    !res ||
    typeof res !== "object" ||
    typeof res.accessToken !== "string" ||
    typeof res.expiresAt !== "number" ||
    !Array.isArray(res.scopes)
  ) {
    throw new ApiError(
      200,
      "API returned a vend response with an unexpected shape",
      "malformed_response",
    );
  }
  return res;
}

export async function revokeGrant(name: string): Promise<RevokeResult> {
  const res = await call<RevokeResult>("DELETE", `/grants/${encodeURIComponent(name)}`);
  // Parity guard. revokeGrantAction only inspects ok-vs-throw, but a 200
  // with an empty body would silently report success on a no-op.
  if (!res || typeof res !== "object" || res.revoked !== true) {
    throw new ApiError(
      200,
      "API returned a revoke response with an unexpected shape",
      "malformed_response",
    );
  }
  return res;
}

// ── Browser-facing helpers (no bearer needed) ──────────────────
// These produce URLs the operator's browser navigates to directly. The /oauth
// surface is open@localhost (defended by HMAC-signed CSRF state); the browser
// must reach the API origin itself so the redirect chain to Google works.

export function oauthStartUrl(grant: string): string {
  return `${API_URL}/oauth/${encodeURIComponent(grant)}/start`;
}

export const KAO_API_BASE = API_URL;
