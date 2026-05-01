import Link from "next/link";
import { Coins, Zap, Calendar, Hash } from "lucide-react";
import { StatCard } from "@/components/stat-card";
import { Sparkline } from "@/components/sparkline";
import { PageHeader } from "@/components/shell";
import {
  getUsageOverview,
  getUsageByCategory,
  getDailyUsageTrend,
  getUsageBySkill,
  getUsageByWatcher,
  type OriginUsage,
} from "@/lib/queries/usage";

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

function shareTone(pct: number): "neutral" | "caution" | "critical" {
  if (pct >= 70) return "critical";
  if (pct >= 40) return "caution";
  return "neutral";
}

function barColorFor(tone: "neutral" | "caution" | "critical"): string {
  if (tone === "critical") return "bg-critical";
  if (tone === "caution") return "bg-caution";
  return "bg-primary/60";
}

export default async function UsagePage() {
  const [overview, categories, dailyTrend, bySkill, byWatcher] = await Promise.all([
    getUsageOverview(),
    getUsageByCategory(30),
    getDailyUsageTrend(30),
    getUsageBySkill(30),
    getUsageByWatcher(30),
  ]);

  const trendValues = dailyTrend.map((d) => d.totalCost);
  const totalCost30d = trendValues.reduce((s, v) => s + v, 0);
  const avgPerDay = trendValues.length ? totalCost30d / trendValues.length : 0;

  return (
    <div className="space-y-8">
      <PageHeader title="Token Usage" description="Cost tracking and consumption analytics" />

      <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Coins} label="Today" value={formatCost(overview.todayCost)} />
        <StatCard icon={Zap} label="This week" value={formatCost(overview.weekCost)} />
        <StatCard icon={Calendar} label="This month" value={formatCost(overview.monthCost)} />
        <StatCard icon={Hash} label="Total tokens" value={overview.totalTokens} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <OriginBreakdown
          title="Cost by skill"
          rows={bySkill}
          hrefBase="/skills"
          empty="No skill activity in the last 30 days."
        />
        <OriginBreakdown
          title="Cost by watcher"
          rows={byWatcher}
          hrefBase="/watchers"
          empty="No watcher activity in the last 30 days."
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="mb-4 flex items-baseline justify-between">
            <h3 className="kicker">Cost by category</h3>
            <span className="text-[11px] tabular-nums text-faint">30 days</span>
          </div>
          {categories.length > 0 ? (
            <div className="space-y-3">
              {categories.map((cat) => {
                const totalAcross = categories.reduce((s, c) => s + c.totalCost, 0);
                const pct = totalAcross > 0 ? (cat.totalCost / totalAcross) * 100 : 0;
                const tone = shareTone(pct);
                return (
                  <div key={cat.category} className="space-y-1.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-foreground">{cat.category}</span>
                      <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
                        {formatCost(cat.totalCost)}
                        <span className="ml-1.5 text-faint">·</span>
                        <span className="ml-1.5 text-faint">{cat.count}</span>
                        <span className="ml-1.5 text-faint">·</span>
                        <span className="ml-1.5 text-faint">{pct.toFixed(0)}%</span>
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full ${barColorFor(tone)} transition-all duration-500`}
                        style={{ width: `${Math.max(2, pct)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-faint">No usage data yet.</p>
          )}
        </div>

        <div className="rounded-lg border border-border bg-card p-5">
          <div className="mb-4 flex items-baseline justify-between">
            <h3 className="kicker">Daily trend</h3>
            <span className="text-[11px] tabular-nums text-faint">30 days</span>
          </div>
          {dailyTrend.length > 0 ? (
            <div className="space-y-4">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <div className="font-mono text-[26px] font-medium leading-none tabular-nums text-foreground">
                    {formatCost(totalCost30d)}
                  </div>
                  <div className="mt-1.5 text-[11px] text-faint">
                    {formatCost(avgPerDay)} avg / day
                  </div>
                </div>
                <Sparkline
                  values={trendValues}
                  width={220}
                  height={48}
                  stroke="var(--color-primary)"
                  ariaLabel="Daily cost over the last 30 days"
                />
              </div>
              <div className="flex items-center justify-between border-t border-border pt-3 text-[10px] tabular-nums text-faint">
                <span>{dailyTrend[0].date}</span>
                <span>
                  {dailyTrend.reduce((s, d) => s + d.totalTokens, 0).toLocaleString()} tokens
                </span>
                <span>{dailyTrend[dailyTrend.length - 1].date}</span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-faint">No usage data yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function OriginBreakdown({
  title,
  rows,
  hrefBase,
  empty,
}: {
  title: string;
  rows: OriginUsage[];
  hrefBase: string;
  empty: string;
}) {
  const total = rows.reduce((s, r) => s + r.totalCost, 0);

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="mb-4 flex items-baseline justify-between">
        <h3 className="kicker">{title}</h3>
        <span className="text-[11px] tabular-nums text-faint">30 days</span>
      </div>
      {rows.length > 0 ? (
        <div className="space-y-3">
          {rows.map((row) => {
            const pct = total > 0 ? (row.totalCost / total) * 100 : 0;
            const tone = shareTone(pct);
            const deleted = row.name === "(deleted)";
            return (
              <div key={row.id} className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  {deleted ? (
                    <span className="truncate text-sm italic text-faint">{row.name}</span>
                  ) : (
                    <Link
                      href={`${hrefBase}/${row.id}`}
                      className="truncate text-sm text-foreground transition-colors hover:text-primary"
                    >
                      {row.name}
                    </Link>
                  )}
                  <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground">
                    {formatCost(row.totalCost)}
                    <span className="ml-1.5 text-faint">·</span>
                    <span className="ml-1.5 text-faint">{row.count}</span>
                    <span className="ml-1.5 text-faint">·</span>
                    <span className="ml-1.5 text-faint">{pct.toFixed(0)}%</span>
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${barColorFor(tone)} transition-all duration-500`}
                    style={{ width: `${Math.max(2, pct)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-faint">{empty}</p>
      )}
    </div>
  );
}
