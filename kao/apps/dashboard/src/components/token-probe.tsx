"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { probeGrantAction, type ProbeResult } from "@/app/actions";
import { hintFor } from "@/lib/error-hints";
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
  // The countdown's `expires in 58m` is computed from Date.now() at render
  // time, so a panel left open would otherwise show a frozen value. Tick at
  // 30s while a probe result is mounted to keep it honest.
  const [, setTick] = useState(0);
  // Tracked so a rapid second Copy click doesn't have its "Copied" flash
  // cancelled early by the prior timer, and so the timer doesn't fire on an
  // unmounted component.
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!result?.ok) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [result]);

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
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
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
            onClick={() => onCopy(result.accessToken)}
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

function maskToken(token: string): string {
  if (token.length <= 8) return "•".repeat(token.length);
  // Google access tokens are ~200 chars — a bullet-per-char mask wraps to a
  // wall of dots, so cap the run and surface the elided length explicitly.
  const head = token.slice(0, 4);
  const tail = token.slice(-4);
  const elided = token.length - 8;
  if (elided <= 24) return `${head}${"•".repeat(elided)}${tail}`;
  return `${head}••• ${elided} chars •••${tail}`;
}
