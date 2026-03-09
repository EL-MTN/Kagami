import { Coins, Zap, Calendar, Hash } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Token Usage</h2>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Coins} label="Today" value={formatCost(overview.todayCost)} />
        <StatCard icon={Zap} label="This Week" value={formatCost(overview.weekCost)} />
        <StatCard icon={Calendar} label="This Month" value={formatCost(overview.monthCost)} />
        <StatCard icon={Hash} label="Total Tokens" value={overview.totalTokens} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Cost by Category (30d)</CardTitle>
          </CardHeader>
          <CardContent>
            {categories.length > 0 ? (
              <div className="space-y-3">
                {categories.map((cat) => {
                  const maxCost = categories[0].totalCost;
                  const pct = maxCost > 0 ? (cat.totalCost / maxCost) * 100 : 0;
                  return (
                    <div key={cat.category} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium">{cat.category}</span>
                        <span className="text-muted-foreground">
                          {formatCost(cat.totalCost)} ({cat.count} calls)
                        </span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${Math.max(2, pct)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No usage data yet.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Daily Trend (30d)</CardTitle>
          </CardHeader>
          <CardContent>
            {dailyTrend.length > 0 ? (
              <div className="space-y-2">
                {dailyTrend.map((day) => (
                  <div key={day.date} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{day.date}</span>
                    <div className="flex items-center gap-3">
                      <span className="w-20 text-right font-mono text-xs">
                        {formatCost(day.totalCost)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        ({day.totalTokens.toLocaleString()} tok)
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No usage data yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
