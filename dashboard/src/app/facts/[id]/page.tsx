import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Calendar, FileText, Hash, Tag, Layers, Plus, Edit, Trash2 } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/shell";
import { Badge } from "@/components/ui/badge";
import { getFact, getFactHistory, type HistoryEvent } from "@/lib/api";
import { formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

const eventStyles: Record<HistoryEvent["event"], { Icon: typeof Plus; tone: string }> = {
  ADD: { Icon: Plus, tone: "text-positive border-positive/30 bg-positive/10" },
  UPDATE: { Icon: Edit, tone: "text-primary border-primary/30 bg-primary/10" },
  DELETE: { Icon: Trash2, tone: "text-critical border-critical/30 bg-critical/10" },
};

export default async function FactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [fact, history] = await Promise.all([getFact(id), getFactHistory(id)]);
  if (!fact) notFound();

  const meta: { label: string; value: string; mono?: boolean }[] = [
    { label: "id", value: fact.id, mono: true },
    { label: "user_id", value: fact.user_id, mono: true },
    { label: "event_date", value: fact.event_date || "—" },
    { label: "created_at", value: fact.created_at },
    { label: "source_session", value: fact.source_session, mono: true },
    { label: "hash", value: fact.hash, mono: true },
  ];
  if (fact.run_id) meta.push({ label: "run_id", value: fact.run_id, mono: true });
  if (fact.agent_id) meta.push({ label: "agent_id", value: fact.agent_id, mono: true });
  if (fact.category) meta.push({ label: "category", value: fact.category });

  return (
    <div className="space-y-8">
      <Link
        href="/facts"
        className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-primary"
      >
        <ArrowLeft className="h-3 w-3" /> Facts
      </Link>

      <PageHeader title="Fact" description="One atomic memory, write-once, dated." />

      <article className="rounded-lg border border-border bg-card p-7">
        <div className="flex items-center gap-3 text-[11px] tabular-nums text-faint">
          <span className="inline-flex items-center gap-1.5">
            <Calendar className="h-3 w-3" strokeWidth={1.75} />
            {fact.event_date || "undated"}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <FileText className="h-3 w-3" strokeWidth={1.75} />
            <span className="font-mono">{fact.source_session}</span>
          </span>
          {fact.category && (
            <Badge variant="muted" className="font-normal">
              <Tag className="h-3 w-3" strokeWidth={1.75} />
              {fact.category}
            </Badge>
          )}
        </div>
        <p className="mt-5 font-display text-2xl leading-relaxed text-foreground">
          {fact.text}
        </p>
      </article>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-5">
          <h3 className="kicker mb-4 inline-flex items-center gap-2">
            <Hash className="h-3 w-3" strokeWidth={1.75} /> Metadata
          </h3>
          <dl className="space-y-2.5 text-xs">
            {meta.map((row) => (
              <div key={row.label} className="grid grid-cols-[110px_1fr] gap-3">
                <dt className="text-faint">{row.label}</dt>
                <dd
                  className={`break-all text-foreground ${row.mono ? "font-mono tabular-nums text-[11px]" : ""}`}
                >
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
          {fact.metadata && Object.keys(fact.metadata).length > 0 && (
            <pre className="mt-5 overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">
              {JSON.stringify(fact.metadata, null, 2)}
            </pre>
          )}
        </div>

        <div className="rounded-lg border border-border bg-card p-5">
          <h3 className="kicker mb-4 inline-flex items-center gap-2">
            <Layers className="h-3 w-3" strokeWidth={1.75} /> Audit log
          </h3>
          {history.events.length === 0 ? (
            <EmptyState variant="inline">No history events.</EmptyState>
          ) : (
            <ol className="relative space-y-0">
              <div className="absolute bottom-3 left-[11px] top-3 w-px bg-border" />
              {history.events.map((ev, idx) => {
                const style = eventStyles[ev.event];
                const Icon = style.Icon;
                return (
                  <li key={idx} className="relative flex gap-3 py-2.5">
                    <div className="relative z-10 mt-1 flex h-[22px] w-[22px] shrink-0 items-center justify-center">
                      <span
                        className={`flex h-[22px] w-[22px] items-center justify-center rounded-full border ${style.tone}`}
                      >
                        <Icon className="h-3 w-3" strokeWidth={2} />
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-xs font-medium text-foreground">{ev.event}</span>
                        <span
                          className="shrink-0 text-[11px] tabular-nums text-faint"
                          title={ev.created_at}
                        >
                          {formatRelative(ev.created_at)}
                        </span>
                      </div>
                      {ev.new_text && (
                        <p className="mt-1 text-[11px] text-muted-foreground line-clamp-2">
                          {ev.new_text}
                        </p>
                      )}
                      {ev.actor && (
                        <p className="mt-0.5 font-mono text-[10px] text-faint">by {ev.actor}</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}
