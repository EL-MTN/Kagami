import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { AttentionList } from "@/components/attention-list";
import { ServiceCard } from "@/components/service-card";
import { fmtRelative } from "@/lib/format";
import { getCockpitData } from "@/lib/cockpit";

export const dynamic = "force-dynamic";

export default async function CockpitPage() {
  const data = await getCockpitData();
  const critical = data.attention.filter((item) => item.severity === "critical").length;
  const warning = data.attention.filter((item) => item.severity === "warning").length;
  const healthy = data.services.filter((service) => service.state === "ok").length;

  return (
    <div className="space-y-7">
      <header className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="kicker">Workspace operator</p>
          <h1 className="mt-2 font-display text-4xl leading-none">Kagami Cockpit</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            One quiet surface for service health, grants, sync, approvals, and open errors.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <SummaryPill icon={CheckCircle2} label="healthy" value={healthy} tone="positive" />
          <SummaryPill icon={AlertTriangle} label="critical" value={critical} tone="critical" />
          <SummaryPill icon={Clock} label="warnings" value={warning} tone="caution" />
        </div>
      </header>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="kicker">Services</h2>
          <time className="font-mono text-[11px] text-faint" dateTime={data.checkedAt}>
            refreshed {fmtRelative(data.checkedAt)}
          </time>
        </div>
        <div className="stagger grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {data.services.map((service) => (
            <ServiceCard key={service.id} service={service} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="kicker">Attention queue</h2>
          <span className="font-mono text-xs text-faint tabular-nums">
            {data.attention.length} items
          </span>
        </div>
        <AttentionList items={data.attention} />
      </section>
    </div>
  );
}

function SummaryPill({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof CheckCircle2;
  label: string;
  value: number;
  tone: "positive" | "critical" | "caution";
}) {
  const toneClass = {
    positive: "border-positive/25 bg-positive/10 text-positive",
    critical: "border-critical/30 bg-critical/10 text-critical",
    caution: "border-caution/30 bg-caution/10 text-caution",
  }[tone];

  return (
    <div className={`rounded-md border px-3 py-2 ${toneClass}`}>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em]">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-1 font-mono text-xl tabular-nums">{value}</div>
    </div>
  );
}
