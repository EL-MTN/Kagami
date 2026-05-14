export const dynamic = "force-dynamic";

const KANSOKU_API_URL = process.env.KANSOKU_API_URL ?? "https://api.kansoku.localhost";

interface HealthProbe {
  ok: boolean;
  detail: string;
}

async function probeApi(): Promise<HealthProbe> {
  try {
    const res = await fetch(`${KANSOKU_API_URL}/health`, { cache: "no-store" });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    return { ok: true, detail: "ok" };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

export default async function OverviewPage() {
  const api = await probeApi();

  return (
    <div className="space-y-10">
      <header className="space-y-2">
        <p className="kicker">観測 · kansoku</p>
        <h1 className="text-4xl font-light tracking-tight">Observation</h1>
        <p className="text-sm text-muted-foreground">
          Centralized logs, traces, errors, and metrics for the Kagami workspace.
        </p>
      </header>

      <section className="rounded-lg border border-border bg-card p-6">
        <div className="flex items-baseline justify-between">
          <h3 className="kicker">Status</h3>
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-medium ${
              api.ok
                ? "border-[color:var(--color-positive)]/30 bg-[color:var(--color-positive)]/10 text-[color:var(--color-positive)]"
                : "border-[color:var(--color-critical)]/30 bg-[color:var(--color-critical)]/10 text-[color:var(--color-critical)]"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                api.ok ? "bg-[color:var(--color-positive)]" : "bg-[color:var(--color-critical)]"
              }`}
            />
            {api.ok ? "API reachable" : "API unreachable"}
          </span>
        </div>
        <div className="mt-4 grid grid-cols-[140px_1fr] gap-3 text-[12px] tabular-nums">
          <span className="text-faint">API base</span>
          <span className="font-mono text-foreground">{KANSOKU_API_URL}</span>
          <span className="text-faint">Health</span>
          <span className="font-mono text-foreground">{api.detail}</span>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-6">
        <h3 className="kicker">Phase 0 — scaffold</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          The API exposes only <code className="font-mono">/health</code> and{" "}
          <code className="font-mono">/version</code> today. Ingest, search, trace view, and
          error grouping arrive in subsequent phases — see{" "}
          <code className="font-mono">kansoku/docs/architecture.md</code>.
        </p>
        <ul className="mt-4 space-y-2 text-sm text-foreground">
          <li className="flex items-center gap-3">
            <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-positive)]" />
            <span>Phase 0 — scaffold</span>
          </li>
          <li className="flex items-center gap-3 text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-border" />
            <span>Phase 1 — ingest + Mongo + shipper</span>
          </li>
          <li className="flex items-center gap-3 text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-border" />
            <span>Phase 2 — live tail + search</span>
          </li>
          <li className="flex items-center gap-3 text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-border" />
            <span>Phase 3 — distributed tracing</span>
          </li>
          <li className="flex items-center gap-3 text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-border" />
            <span>Phase 4 — error fingerprinting</span>
          </li>
        </ul>
      </section>
    </div>
  );
}
