import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/shell";
import { Sparkline } from "@/components/sparkline";
import {
  listServices,
  getServiceTimeline,
  type ServiceSummary,
  type ServiceTimelineBucket,
} from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface ServicesPageProps {
  searchParams: Promise<{ windowHours?: string }>;
}

const WINDOW_OPTIONS = [1, 6, 24, 24 * 7];

export default async function ServicesPage({ searchParams }: ServicesPageProps) {
  const params = await searchParams;
  const windowHours = Math.min(
    Math.max(Number.parseInt(params.windowHours ?? "24", 10) || 24, 1),
    720,
  );

  let services: ServiceSummary[] = [];
  let fetchError: string | undefined;
  try {
    const res = await listServices({ windowHours });
    services = res.services;
  } catch (err) {
    fetchError = (err as Error).message;
  }

  // Timelines are independent per service — fetch in parallel so a row with
  // a slow aggregation doesn't block the rest. Failure on any one timeline
  // is non-fatal: the card renders without a sparkline.
  const timelines = await Promise.all(
    services.map(async (s) => {
      try {
        const t = await getServiceTimeline(s.service, { windowHours });
        return { service: s.service, buckets: t.buckets };
      } catch {
        return { service: s.service, buckets: [] as ServiceTimelineBucket[] };
      }
    }),
  );
  const timelineByService = new Map(timelines.map((t) => [t.service, t.buckets]));

  return (
    <div className="space-y-8">
      <PageHeader
        title="Services"
        description={`Per-service log volume, error rate, and last-seen activity over the last ${windowHours}h.`}
        meta={
          <span className="text-[11px] tabular-nums text-faint">
            {services.length} service{services.length === 1 ? "" : "s"}
          </span>
        }
      />

      <nav
        aria-label="Window"
        className="flex items-center gap-2 text-[11px] tabular-nums text-faint"
      >
        <span className="tracking-wider uppercase">Window</span>
        {WINDOW_OPTIONS.map((h) => (
          <Link
            key={h}
            href={`/services?windowHours=${h}`}
            aria-current={h === windowHours ? "page" : undefined}
            className={cn(
              "rounded-md border px-2 py-0.5 font-mono transition-colors",
              h === windowHours
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-border bg-background text-muted-foreground hover:text-foreground",
            )}
          >
            {h < 24 ? `${h}h` : `${h / 24}d`}
          </Link>
        ))}
      </nav>

      {fetchError && (
        <div className="rounded-lg border border-[color:var(--color-critical)]/30 bg-[color:var(--color-critical)]/5 p-4 text-[12px] text-[color:var(--color-critical)]">
          {fetchError}
        </div>
      )}

      {services.length === 0 && !fetchError ? (
        <EmptyState>No services have reported logs in this window.</EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {services.map((s) => (
            <ServiceCard
              key={s.service}
              service={s}
              timeline={timelineByService.get(s.service) ?? []}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ServiceCard({
  service,
  timeline,
}: {
  service: ServiceSummary;
  timeline: ServiceTimelineBucket[];
}) {
  const counts = timeline.map((b) => b.count);
  const errorCounts = timeline.map((b) => b.errorCount);
  const errorRate = service.count > 0 ? service.errorCount / service.count : 0;
  // Show "0" when there are no errors; otherwise format to 2 decimals so a
  // 1-error-in-100k rate doesn't truncate to 0.0%.
  const errorPct = service.errorCount === 0 ? "0" : (errorRate * 100).toFixed(2);
  // Tone thresholds: a single error in a high-volume bucket isn't a
  // critical-paint reason. Use rate > 1% as the critical cutoff and rate
  // > 0.1% (or any warn) as caution. Anything cleaner is positive.
  const CRITICAL_RATE = 0.01;
  const CAUTION_RATE = 0.001;
  const tone =
    errorRate > CRITICAL_RATE
      ? "critical"
      : errorRate > CAUTION_RATE || service.warnCount > 0
        ? "caution"
        : service.count > 0
          ? "positive"
          : "neutral";

  return (
    <Link
      href={`/search?service=${encodeURIComponent(service.service)}`}
      className="group flex flex-col gap-3 rounded-lg border border-border bg-card p-5 transition-colors hover:border-primary/30"
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-mono text-sm text-foreground">{service.service}</h3>
          <p className="text-[11px] text-faint">{service.components.join(" · ")}</p>
        </div>
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
      </div>

      <div className="grid grid-cols-3 gap-3 text-[11px] tabular-nums">
        <Stat label="Logs" value={service.count.toLocaleString()} tone="neutral" />
        <Stat
          label="Errors"
          value={service.errorCount.toLocaleString()}
          tone={tone === "critical" ? "critical" : "neutral"}
        />
        <Stat label="Error %" value={`${errorPct}%`} tone={tone} />
      </div>

      <div
        className={cn(
          "text-[color:var(--color-primary)]",
          service.errorCount > 0 && "text-[color:var(--color-critical)]",
        )}
      >
        <Sparkline values={counts} ariaLabel="log volume" width={280} height={36} />
      </div>
      {service.errorCount > 0 && (
        <div className="text-[color:var(--color-critical)] opacity-60">
          <Sparkline values={errorCounts} ariaLabel="error volume" width={280} height={20} />
        </div>
      )}

      <p className="text-[11px] tabular-nums text-faint">
        last seen {service.lastSeen ? formatRelative(service.lastSeen) : "—"}
      </p>
    </Link>
  );
}

type Tone = "neutral" | "positive" | "caution" | "critical";

function Stat({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  const toneClass: Record<Tone, string> = {
    neutral: "text-foreground",
    positive: "text-[color:var(--color-positive)]",
    caution: "text-[color:var(--color-caution)]",
    critical: "text-[color:var(--color-critical)]",
  };
  return (
    <div>
      <p className="tracking-wider text-faint uppercase">{label}</p>
      <p className={cn("mt-1 font-mono text-sm", toneClass[tone])}>{value}</p>
    </div>
  );
}
