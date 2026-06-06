import Link from "next/link";
import { ArrowUpRight, CheckCircle2 } from "lucide-react";
import { SeverityBadge } from "@/components/badge";
import { fmtRelative } from "@/lib/format";
import type { AttentionItem, ServiceId } from "@/lib/types";

const serviceLabel: Record<ServiceId, string> = {
  kioku: "Kioku",
  kokoro: "Kokoro",
  kizuna: "Kizuna",
  kansoku: "Kansoku",
  kao: "Kao",
};

export function AttentionList({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-card px-5 py-8 text-center">
        <CheckCircle2 className="mx-auto h-6 w-6 text-positive" />
        <p className="mt-3 text-sm font-medium">No attention items</p>
        <p className="mt-1 text-xs text-muted-foreground">All visible service checks are quiet.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="hidden grid-cols-[112px_minmax(0,1fr)_96px_24px] gap-3 border-b border-border px-4 py-2.5 text-[11px] uppercase tracking-[0.16em] text-faint sm:grid">
        <span>Severity</span>
        <span>Item</span>
        <span>Service</span>
        <span />
      </div>
      <div className="divide-y divide-border">
        {items.map((item) => (
          <Link
            key={item.id}
            href={item.href}
            className="relative block px-4 py-3 pr-10 transition-colors hover:bg-accent sm:grid sm:grid-cols-[112px_minmax(0,1fr)_96px_24px] sm:gap-3 sm:pr-4"
          >
            <div className="mb-2 sm:mb-0">
              <SeverityBadge severity={item.severity} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{item.title}</div>
              <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                {item.detail ? <span className="truncate">{item.detail}</span> : null}
                <time
                  className="shrink-0 font-mono text-[11px] text-faint"
                  dateTime={item.detectedAt}
                >
                  {fmtRelative(item.detectedAt)}
                </time>
              </div>
            </div>
            <div className="mt-2 self-center text-xs text-muted-foreground sm:mt-0">
              {serviceLabel[item.service]}
            </div>
            <ArrowUpRight className="absolute right-4 top-4 h-4 w-4 text-faint sm:static sm:mt-0.5 sm:self-center" />
          </Link>
        ))}
      </div>
    </div>
  );
}
