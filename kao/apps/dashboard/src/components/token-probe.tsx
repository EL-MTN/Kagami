"use client";

import { useState, useTransition } from "react";
import { probeGrantAction, type ProbeResult } from "@/app/actions";
import { formatCountdown, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

// Operator probe. Bypasses Kao's in-process cache (`?force=1` in api.ts) so a
// success means we genuinely re-vended against Google, not that the previous
// cached token is still valid. Surfaces the access token because the operator
// explicitly opted in to seeing it — they typically want to paste it into
// curl/Postman to reproduce a consumer failure. The structured failure path
// matters more than the success path: `no_grant`, `invalid_grant`,
// `decrypt_failed`, and `bad_gateway` each suggest a different next action
// and the panel tells you which.

interface TokenProbeProps {
  grant: string;
  granted: boolean;
}

export function TokenProbe({ grant, granted }: TokenProbeProps) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const run = () => {
    setCopied(false);
    startTransition(async () => {
      const r = await probeGrantAction(grant);
      setResult(r);
      setRevealed(false);
    });
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be unavailable in some contexts (non-HTTPS, no
      // permission). Falling silent is fine — the token's also visible.
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-3 px-5 py-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">Probe access token</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Round-trips Google (bypasses Kao&rsquo;s cache) and surfaces the live access token.
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={pending || !granted}
          className={cn(
            "rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary",
            (pending || !granted) && "opacity-60",
          )}
          title={granted ? undefined : "Connect this grant before probing"}
        >
          {pending ? "Probing…" : result ? "Probe again" : "Probe"}
        </button>
      </div>

      {result && (
        <div className="border-t border-border px-5 py-4">
          {result.ok ? (
            <ProbeSuccess
              result={result}
              revealed={revealed}
              onReveal={() => setRevealed((v) => !v)}
              onCopy={(text) => {
                // `copy` is async; the prop is typed void to keep the success
                // panel's callbacks uniform with React's other void handlers.
                void copy(text);
              }}
              copied={copied}
            />
          ) : (
            <ProbeFailure result={result} />
          )}
        </div>
      )}
    </div>
  );
}

function ProbeSuccess({
  result,
  revealed,
  onReveal,
  onCopy,
  copied,
}: {
  result: Extract<ProbeResult, { ok: true }>;
  revealed: boolean;
  onReveal: () => void;
  onCopy: (text: string) => void;
  copied: boolean;
}) {
  const displayed = revealed ? result.accessToken : maskToken(result.accessToken);
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--color-positive)]/10 px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-positive)]">
          <span className="h-1 w-1 rounded-full bg-[color:var(--color-positive)]" aria-hidden />
          vended
        </span>
        <span className="text-xs text-faint">
          expires in {formatCountdown(result.expiresAt)} · at {formatDateTime(result.expiresAt)}
        </span>
      </div>

      <div className="kicker">access token</div>
      <div className="flex items-start gap-2">
        <code
          className="block flex-1 min-w-0 break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground"
          aria-label="access token"
        >
          {displayed}
        </code>
        <div className="flex shrink-0 flex-col gap-1.5">
          <button
            type="button"
            onClick={onReveal}
            className="rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {revealed ? "Hide" : "Reveal"}
          </button>
          <button
            type="button"
            onClick={() => {
              // Discard the clipboard promise — onCopy's signature is `Promise<void>`
              // but React's onClick wants a `void`-returning handler.
              void onCopy(result.accessToken);
            }}
            className="rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      <div className="kicker pt-1">scopes vended</div>
      <ul className="space-y-1">
        {result.scopes.map((s) => (
          <li key={s}>
            <code className="font-mono text-xs text-muted-foreground">{s}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProbeFailure({ result }: { result: Extract<ProbeResult, { ok: false }> }) {
  const hint = hintFor(result.code);
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--color-critical)]/10 px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-critical)]">
          <span className="h-1 w-1 rounded-full bg-[color:var(--color-critical)]" aria-hidden />
          {result.code}
        </span>
        <span className="text-xs text-faint">HTTP {result.status || "—"}</span>
      </div>
      <p className="font-mono text-xs text-muted-foreground">{result.message}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

// Mirrors Kao's vend-route taxonomy in api/src/routes/grants.ts so an operator
// reading the panel doesn't need to also read docs to know what's actionable.
function hintFor(code: string): string | null {
  switch (code) {
    case "no_grant":
      return "No active refresh token. Click Connect Google to grant consent.";
    case "invalid_grant":
      return "Google rejected the stored refresh token. Click Re-consent to grant a fresh one.";
    case "decrypt_failed":
      return "Kao can't decrypt the stored refresh token (likely a rotated KAO_ENCRYPTION_KEY). Re-consent to overwrite it.";
    case "bad_gateway":
      return "Transient failure talking to Google. Try Probe again in a few seconds.";
    case "unauthorized":
      return "Dashboard bearer (KAO_TOKEN) doesn't match the API's. Check apps/dashboard/.env.";
    case "unreachable":
      return "Couldn't reach the Kao API at all. Is it running?";
    default:
      return null;
  }
}

function maskToken(token: string): string {
  if (token.length <= 8) return "•".repeat(token.length);
  return `${token.slice(0, 4)}${"•".repeat(Math.max(0, token.length - 8))}${token.slice(-4)}`;
}
