import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/shell";
import { FactCard } from "@/components/fact-card";
import { Badge } from "@/components/ui/badge";
import { listFacts } from "@/lib/api";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

interface SearchParams {
  page?: string;
  since?: string;
  until?: string;
  source_session?: string;
  user_id?: string;
}

export default async function FactsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const { facts, total } = await listFacts({
    limit: PAGE_SIZE,
    offset,
    since: sp.since,
    until: sp.until,
    source_session: sp.source_session,
    user_id: sp.user_id,
  });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filterEntries = Object.entries(sp).filter(
    ([k, v]) => k !== "page" && v !== undefined && v !== "",
  );

  const buildHref = (overrides: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(sp) as [string, string | undefined][]) {
      if (v !== undefined && v !== "") next.set(k, v);
    }
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined || v === "") next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    return qs ? `/facts?${qs}` : "/facts";
  };

  return (
    <div className="space-y-8">
      <PageHeader
        title="Facts"
        description="Atomic, write-once memory cells. Newer event_date wins on conflict."
        meta={
          <p className="text-[11px] tabular-nums text-faint">
            <span className="font-mono text-foreground">{total.toLocaleString()}</span> total
          </p>
        }
      />

      {filterEntries.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="kicker">Filtered by</span>
          {filterEntries.map(([k, v]) => (
            <Link key={k} href={buildHref({ [k]: undefined, page: undefined })}>
              <Badge variant="outline" className="cursor-pointer hover:bg-accent">
                {k}: <span className="font-mono">{v}</span> ×
              </Badge>
            </Link>
          ))}
        </div>
      )}

      {facts.length === 0 ? (
        <EmptyState>No facts match the current filter.</EmptyState>
      ) : (
        <div className="stagger space-y-2.5">
          {facts.map((f) => (
            <FactCard key={f.id} fact={f} />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-border pt-4 text-[11px] tabular-nums text-faint">
          <span>
            page <span className="font-mono text-foreground">{page}</span> of{" "}
            <span className="font-mono text-foreground">{totalPages}</span> · {offset + 1}–
            {Math.min(offset + PAGE_SIZE, total)} of{" "}
            <span className="font-mono">{total.toLocaleString()}</span>
          </span>
          <div className="flex items-center gap-1">
            {page > 1 && (
              <Link
                href={buildHref({ page: String(page - 1) })}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ChevronLeft className="h-3 w-3" /> prev
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={buildHref({ page: String(page + 1) })}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                next <ChevronRight className="h-3 w-3" />
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
