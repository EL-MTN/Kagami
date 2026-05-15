import Link from "next/link";
import { ArrowRight, Activity, Database, Server } from "lucide-react";
import { PageHeader } from "@/components/shell";
import { getHealth, getVersion, KANSOKU_BASE } from "@/lib/api";

export const dynamic = "force-dynamic";

interface Probe<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function probe<T>(fn: () => Promise<T>): Promise<Probe<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export default async function OverviewPage() {
  const [health, version] = await Promise.all([probe(getHealth), probe(getVersion)]);
  const allOk = health.ok && version.ok;

  return (
    <div className="space-y-10">
      <PageHeader
        title="Overview"
        description="Centralized logs, traces, errors, and metrics for the Kagami workspace."
        meta={
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-medium ${
              allOk
                ? "border-[color:var(--color-positive)]/30 bg-[color:var(--color-positive)]/10 text-[color:var(--color-positive)]"
                : "border-[color:var(--color-critical)]/30 bg-[color:var(--color-critical)]/10 text-[color:var(--color-critical)]"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                allOk ? "bg-[color:var(--color-positive)]" : "bg-[color:var(--color-critical)]"
              }`}
            />
            {allOk ? "All systems normal" : "Degraded"}
          </span>
        }
      />

      <section className="grid gap-3 sm:grid-cols-3">
        <StatusCard
          icon={Server}
          label="API"
          status={health.ok ? "ok" : "down"}
          value={health.ok ? "ok" : (health.error ?? "unreachable")}
        />
        <StatusCard
          icon={Activity}
          label="Version"
          status={version.ok ? "ok" : "down"}
          value={version.ok ? `${version.data!.name} v${version.data!.version}` : "—"}
        />
        <StatusCard icon={Database} label="Retention" status="ok" value="30 days · time-series" />
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <FeatureCard
          href="/tail"
          title="Live tail"
          description="Stream from every shipper in real time. Filter by service or level; pause to inspect."
        />
        <FeatureCard
          href="/search"
          title="Search"
          description="Query the persisted log store by service, level, and time range."
        />
        <FeatureCard
          href="/errors"
          title="Errors"
          description="Distinct error fingerprints with counts, first/last seen, and trace links."
        />
      </section>

      <section className="rounded-lg border border-border bg-card p-5 text-[11px] tabular-nums text-faint">
        <div className="grid grid-cols-[140px_1fr] gap-4">
          <span>API base</span>
          <span className="font-mono text-foreground">{KANSOKU_BASE}</span>
        </div>
      </section>
    </div>
  );
}

function StatusCard({
  icon: Icon,
  label,
  status,
  value,
}: {
  icon: typeof Server;
  label: string;
  status: "ok" | "down";
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <div className="inline-flex items-center gap-2 text-[11px] tracking-wider text-faint uppercase">
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
          {label}
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${
            status === "ok"
              ? "bg-[color:var(--color-positive)]/10 text-[color:var(--color-positive)]"
              : "bg-[color:var(--color-critical)]/10 text-[color:var(--color-critical)]"
          }`}
        >
          <span
            className={`h-1 w-1 rounded-full ${
              status === "ok"
                ? "bg-[color:var(--color-positive)]"
                : "bg-[color:var(--color-critical)]"
            }`}
          />
          {status}
        </span>
      </div>
      <p className="mt-3 font-mono text-sm text-foreground">{value}</p>
    </div>
  );
}

function FeatureCard({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-2 rounded-lg border border-border bg-card p-5 transition-colors hover:border-primary/30"
    >
      <div className="flex items-baseline justify-between">
        <h3 className="text-base font-medium text-foreground">{title}</h3>
        <ArrowRight className="h-4 w-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
    </Link>
  );
}
