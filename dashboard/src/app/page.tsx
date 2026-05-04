import Link from "next/link";
import { Layers, Library, Tags, ArrowRight } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/shell";
import { StatCard } from "@/components/stat-card";
import { FactCard } from "@/components/fact-card";
import { Sparkline } from "@/components/sparkline";
import { Stratum } from "@/components/stratum";
import { getFactCount, listFacts, type Fact } from "@/lib/api";
import { monthKey } from "@/lib/format";

export const dynamic = "force-dynamic";

function aggregateBy<T, K extends string>(items: T[], key: (it: T) => K | undefined) {
  const map = new Map<K, number>();
  for (const it of items) {
    const k = key(it);
    if (k === undefined) continue;
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([k, count]) => ({ key: k, count }))
    .sort((a, b) => b.count - a.count);
}

function buildSparkline(facts: Fact[], days = 30): number[] {
  const buckets = new Array(days).fill(0);
  const now = Date.now();
  for (const f of facts) {
    const t = new Date(f.created_at).getTime();
    const ageDays = Math.floor((now - t) / 86_400_000);
    if (ageDays < 0 || ageDays >= days) continue;
    buckets[days - 1 - ageDays] += 1;
  }
  return buckets;
}

export default async function OverviewPage() {
  const [{ count }, listed] = await Promise.all([
    getFactCount(),
    listFacts({ limit: 500 }),
  ]);

  const facts = listed.facts;
  const recent = facts.slice(0, 6);
  const sessions = aggregateBy(facts, (f) => f.source_session);
  const categories = aggregateBy(facts, (f) => f.category);
  const months = aggregateBy(facts, (f) => (f.event_date ? monthKey(f.event_date) : undefined));
  const spark = buildSparkline(facts, 30);
  const last7 = spark.slice(-7).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-10">
      <PageHeader
        title="Overview"
        description="Atomic facts in MongoDB — accumulated, dated, indexed for hybrid retrieval."
        meta={
          <div className="text-right">
            <p className="kicker">Total in memory</p>
            <p className="mt-1 font-mono text-[28px] leading-none tabular-nums text-foreground">
              {count.toLocaleString()}
            </p>
          </div>
        }
      />

      <div className="stagger grid gap-3 sm:grid-cols-3">
        <StatCard
          icon={Layers}
          label="Facts"
          value={count}
          hint={`+${last7} in the last 7d`}
          hintTone={last7 > 0 ? "positive" : "neutral"}
        />
        <StatCard icon={Library} label="Sessions" value={sessions.length} />
        <StatCard icon={Tags} label="Categories" value={categories.length} />
      </div>

      <section className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="flex items-baseline justify-between">
            <h3 className="kicker">Memory stratum</h3>
            <p className="text-[11px] tabular-nums text-faint">
              by event date, deepest = oldest
            </p>
          </div>
          <div className="mt-5">
            <Stratum layers={months.map((m) => ({ monthKey: m.key, count: m.count }))} />
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border border-border bg-card p-5">
            <h3 className="kicker">Ingest cadence</h3>
            <p className="mt-1 text-[11px] text-faint">facts added per day, last 30d</p>
            <div className="mt-4 text-positive">
              <Sparkline values={spark} width={280} height={72} ariaLabel="ingest cadence" />
            </div>
            <div className="mt-3 flex items-baseline justify-between text-[11px] tabular-nums text-faint">
              <span>30d ago</span>
              <span className="text-foreground">{spark.reduce((a, b) => a + b, 0)} total</span>
              <span>today</span>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-baseline justify-between">
              <h3 className="kicker">Top categories</h3>
              <Link
                href="/facts"
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-primary"
              >
                Browse <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            {categories.length === 0 ? (
              <p className="mt-4 text-[11px] text-faint">No categories yet.</p>
            ) : (
              <ul className="mt-4 space-y-2">
                {categories.slice(0, 6).map((c) => (
                  <li key={c.key} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate text-foreground">{c.key}</span>
                    <span className="font-mono text-[11px] tabular-nums text-faint">
                      {c.count}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="kicker">Recently added</h3>
          <Link
            href="/facts"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-primary"
          >
            View all <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
        {recent.length === 0 ? (
          <EmptyState>No facts yet — ingest a session to populate memory.</EmptyState>
        ) : (
          <div className="stagger grid gap-2.5">
            {recent.map((f) => (
              <FactCard key={f.id} fact={f} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
