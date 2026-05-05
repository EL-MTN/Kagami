import { Activity, Server, Database } from "lucide-react";
import { PageHeader } from "@/components/shell";
import { getHealth, getVersion, getFactCount, KIOKU_BASE } from "@/lib/api";

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

export default async function HealthPage() {
  const [health, version, count] = await Promise.all([
    probe(getHealth),
    probe(getVersion),
    probe(getFactCount),
  ]);

  const allOk = health.ok && version.ok && count.ok;

  const rows: { label: string; status: "ok" | "down"; value: string; Icon: typeof Server }[] = [
    {
      label: "API",
      status: health.ok ? "ok" : "down",
      value: health.ok ? "ok" : (health.error ?? "unreachable"),
      Icon: Server,
    },
    {
      label: "Version",
      status: version.ok ? "ok" : "down",
      value: version.ok ? `${version.data!.name} v${version.data!.version}` : "—",
      Icon: Activity,
    },
    {
      label: "Storage",
      status: count.ok ? "ok" : "down",
      value: count.ok ? `${count.data!.count.toLocaleString()} facts` : "—",
      Icon: Database,
    },
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        title="Health"
        description="Liveness, version, and storage probes for the Kioku backend."
        meta={
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-medium ${
              allOk
                ? "border-positive/30 bg-positive/10 text-positive"
                : "border-critical/30 bg-critical/10 text-critical"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${allOk ? "bg-positive" : "bg-critical"}`}
              style={{ animation: "pulse-soft 2s ease-in-out infinite" }}
            />
            {allOk ? "All systems normal" : "Degraded"}
          </span>
        }
      />

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {rows.map((r, idx) => (
          <div
            key={r.label}
            className={`grid grid-cols-[140px_1fr_120px] items-center gap-4 px-5 py-4 ${idx > 0 ? "border-t border-border" : ""}`}
          >
            <span className="inline-flex items-center gap-2 text-xs font-medium text-foreground">
              <r.Icon className="h-3.5 w-3.5 text-faint" strokeWidth={1.75} />
              {r.label}
            </span>
            <span
              className={`font-mono text-[12px] tabular-nums ${r.status === "ok" ? "text-foreground" : "text-critical"}`}
            >
              {r.value}
            </span>
            <span className="justify-self-end">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  r.status === "ok"
                    ? "bg-positive/10 text-positive"
                    : "bg-critical/10 text-critical"
                }`}
              >
                <span
                  className={`h-1 w-1 rounded-full ${r.status === "ok" ? "bg-positive" : "bg-critical"}`}
                />
                {r.status}
              </span>
            </span>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-border bg-card p-5 text-[11px] tabular-nums text-faint">
        <div className="grid grid-cols-[140px_1fr] gap-4">
          <span>API base</span>
          <span className="font-mono text-foreground">{KIOKU_BASE}</span>
        </div>
      </div>
    </div>
  );
}
