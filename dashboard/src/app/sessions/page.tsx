import Link from "next/link";
import { Library, ArrowRight } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/shell";
import { listFacts } from "@/lib/api";

export const dynamic = "force-dynamic";

interface SessionRow {
  source_session: string;
  count: number;
  earliest: string;
  latest: string;
  user_ids: Set<string>;
}

export default async function SessionsPage() {
  const { facts } = await listFacts({ limit: 500 });

  const map = new Map<string, SessionRow>();
  for (const f of facts) {
    const key = f.source_session || "(none)";
    const row = map.get(key);
    if (row) {
      row.count += 1;
      if (f.event_date && f.event_date < row.earliest) row.earliest = f.event_date;
      if (f.event_date && f.event_date > row.latest) row.latest = f.event_date;
      row.user_ids.add(f.user_id);
    } else {
      map.set(key, {
        source_session: key,
        count: 1,
        earliest: f.event_date || "—",
        latest: f.event_date || "—",
        user_ids: new Set([f.user_id]),
      });
    }
  }

  const rows = [...map.values()].sort((a, b) => b.count - a.count);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Sessions"
        description="Source transcripts each fact was extracted from."
        meta={
          <p className="text-[11px] tabular-nums text-faint">
            <span className="font-mono text-foreground">{rows.length}</span> sessions ·{" "}
            <span className="font-mono text-foreground">{facts.length}</span> facts
          </p>
        }
      />

      {rows.length === 0 ? (
        <EmptyState>No sessions yet.</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="grid grid-cols-[1fr_120px_120px_80px_auto] items-center gap-4 border-b border-border bg-muted/40 px-5 py-3">
            <span className="kicker">Session</span>
            <span className="kicker text-right">Earliest</span>
            <span className="kicker text-right">Latest</span>
            <span className="kicker text-right">Facts</span>
            <span className="kicker text-right">·</span>
          </div>
          <ul>
            {rows.map((r, idx) => (
              <li
                key={r.source_session}
                className="group grid grid-cols-[1fr_120px_120px_80px_auto] items-center gap-4 border-b border-border px-5 py-3.5 last:border-b-0 transition-colors hover:bg-accent/40"
                style={{
                  animation: `fade-in 0.4s ease-out both`,
                  animationDelay: `${Math.min(idx, 8) * 40}ms`,
                }}
              >
                <Link
                  href={`/facts?source_session=${encodeURIComponent(r.source_session)}`}
                  className="flex items-center gap-2.5 truncate text-sm text-foreground transition-colors hover:text-primary"
                >
                  <Library className="h-3.5 w-3.5 shrink-0 text-faint" strokeWidth={1.75} />
                  <span className="truncate font-mono text-[12px]">{r.source_session}</span>
                </Link>
                <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                  {r.earliest}
                </span>
                <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                  {r.latest}
                </span>
                <span className="text-right font-mono text-[12px] tabular-nums text-foreground">
                  {r.count}
                </span>
                <Link
                  href={`/facts?source_session=${encodeURIComponent(r.source_session)}`}
                  className="text-faint opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label="open"
                >
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
