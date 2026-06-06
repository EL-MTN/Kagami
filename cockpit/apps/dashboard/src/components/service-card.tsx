import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { StateBadge } from "@/components/badge";
import { cn } from "@/lib/cn";
import type { ServiceCard as ServiceCardType } from "@/lib/types";

const serviceAccent: Record<ServiceCardType["id"], string> = {
  kioku: "bg-kioku",
  kokoro: "bg-kokoro",
  kizuna: "bg-kizuna",
  kansoku: "bg-kansoku",
  kao: "bg-kao",
};

export function ServiceCard({ service }: { service: ServiceCardType }) {
  return (
    <Link
      href={service.href}
      className="group block rounded-md border border-border bg-card p-4 shadow-sm transition-colors hover:border-rule-strong"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="relative grid h-10 w-10 place-items-center rounded-md border border-border bg-background font-display text-2xl">
            <span
              className={cn(
                "absolute left-0 top-0 h-full w-1 rounded-l-md",
                serviceAccent[service.id],
              )}
            />
            {service.kanji}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold leading-none">{service.name}</h2>
              <ArrowUpRight className="h-3.5 w-3.5 text-faint transition-colors group-hover:text-primary" />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{service.role}</p>
          </div>
        </div>
        <StateBadge state={service.state} />
      </div>

      <div className="mt-5 min-h-12">
        <p className="text-sm font-medium text-foreground">{service.summary}</p>
        {service.detail ? (
          <p className="mt-1 text-xs text-muted-foreground">{service.detail}</p>
        ) : null}
      </div>

      <div className="mt-4 flex items-end justify-between border-t border-border pt-3">
        {service.metric ? (
          <div>
            <div className="font-mono text-xl tabular-nums">{service.metric.value}</div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-faint">
              {service.metric.label}
            </div>
          </div>
        ) : (
          <div className="text-xs text-faint">No metric</div>
        )}
        <time className="font-mono text-[11px] text-faint" dateTime={service.checkedAt}>
          checked
        </time>
      </div>
    </Link>
  );
}
