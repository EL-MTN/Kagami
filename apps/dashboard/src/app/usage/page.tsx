import { Coins, Zap, Calendar, Hash } from "lucide-react";
import { StatCard } from "@/components/stat-card";
import { getUsageOverview, getUsageByCategory, getDailyUsageTrend } from "@/lib/queries/usage";

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

export default async function UsagePage() {
  const [overview, categories, dailyTrend] = await Promise.all([
    getUsageOverview(),
    getUsageByCategory(30),
    getDailyUsageTrend(30),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="font-display text-3xl text-foreground">Token Usage</h2>
        <p className="mt-1 text-sm text-muted-foreground/70">
          Cost tracking and consumption analytics
        </p>
      </div>

      <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Coins} label="Today" value={formatCost(overview.todayCost)} />
        <StatCard icon={Zap} label="This Week" value={formatCost(overview.weekCost)} />
        <StatCard icon={Calendar} label="This Month" value={formatCost(overview.monthCost)} />
        <StatCard icon={Hash} label="Total Tokens" value={overview.totalTokens} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-6">
          <h3 className="mb-6 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
            Cost by Category
            <span className="ml-2 font-normal normal-case tracking-normal text-muted-foreground/40">
              30 days
            </span>
          </h3>
          {categories.length > 0 ? (
            <div className="space-y-4">
              {categories.map((cat) => {
                const maxCost = categories[0].totalCost;
                const pct = maxCost > 0 ? (cat.totalCost / maxCost) * 100 : 0;
                return (
                  <div key={cat.category} className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-foreground/80">{cat.category}</span>
                      <span className="text-xs tabular-nums text-muted-foreground/60">
                        {formatCost(cat.totalCost)}
                        <span className="ml-1 text-muted-foreground/30">({cat.count})</span>
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary/60 transition-all duration-500"
                        style={{ width: `${Math.max(2, pct)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground/50">No usage data yet.</p>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card p-6">
          <h3 className="mb-6 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
            Daily Trend
            <span className="ml-2 font-normal normal-case tracking-normal text-muted-foreground/40">
              30 days
            </span>
          </h3>
          {dailyTrend.length > 0 ? (
            <div className="space-y-2">
              {dailyTrend.map((day) => (
                <div key={day.date} className="flex items-center justify-between text-xs">
                  <span className="tabular-nums text-muted-foreground/40">{day.date}</span>
                  <div className="flex items-center gap-3">
                    <span className="w-20 text-right font-mono tabular-nums text-muted-foreground/70">
                      {formatCost(day.totalCost)}
                    </span>
                    <span className="text-[10px] text-muted-foreground/30">
                      {day.totalTokens.toLocaleString()} tok
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground/50">No usage data yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
