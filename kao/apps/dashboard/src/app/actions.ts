"use server";

import { revalidatePath } from "next/cache";
import { ApiError, revokeGrant, vendToken } from "@/lib/api";

// All mutations live here so the page files stay declarative. Server Actions
// are the only path Kao's bearer-gated surface is reached from the browser:
// the bearer is read inside `api.ts` from the dashboard's own env, never
// crossing into the rendered HTML.

// Structured result mirrors `ProbeResult` so the button can render failure
// inline. Throwing out of a Server Action that's awaited inside
// `startTransition` shows the default Next error overlay and leaves the
// caller's transient state (e.g. "confirming") stuck — we never want that.
export type RevokeActionResult =
  | { ok: true; grant: string }
  | { ok: false; grant: string; status: number; code: string; message: string };

export async function revokeGrantAction(grant: string): Promise<RevokeActionResult> {
  try {
    await revokeGrant(grant);
    // Both routes display the grant; revalidate both so a revoke from anywhere
    // updates anywhere. Encode the segment for symmetry with the other path
    // uses (api.ts), even though the API rejects non-registry names upstream.
    revalidatePath("/");
    revalidatePath(`/grants/${encodeURIComponent(grant)}`);
    return { ok: true, grant };
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        ok: false,
        grant,
        status: err.status,
        code: err.code ?? "unknown",
        message: err.message,
      };
    }
    return {
      ok: false,
      grant,
      status: 0,
      code: "unreachable",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// Shape rendered by the probe panel. Success returns the live access token
// (the operator asked for it explicitly — localhost trust boundary), failure
// returns a structured code so the panel can suggest the right next step
// without parsing free-text.
export type ProbeResult =
  | {
      ok: true;
      grant: string;
      accessToken: string;
      expiresAt: number;
      scopes: string[];
    }
  | {
      ok: false;
      grant: string;
      status: number;
      code: string;
      message: string;
    };

export async function probeGrantAction(grant: string): Promise<ProbeResult> {
  try {
    const vended = await vendToken(grant);
    return {
      ok: true,
      grant,
      accessToken: vended.accessToken,
      expiresAt: vended.expiresAt,
      scopes: vended.scopes,
    };
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        ok: false,
        grant,
        status: err.status,
        // For the vend route Kao puts the actionable code inside
        // `details.code` (no_grant / invalid_grant / decrypt_failed); api.ts
        // already promotes that into `ApiError.code`.
        code: err.code ?? "unknown",
        message: err.message,
      };
    }
    return {
      ok: false,
      grant,
      status: 0,
      code: "unreachable",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
