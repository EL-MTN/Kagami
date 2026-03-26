import { MessageSquare, Brain, Lightbulb, Bell } from "lucide-react";
import { StatCard } from "@/components/stat-card";
import { EmotionalIndicator } from "@/components/emotional-indicator";
import { ActivityFeed } from "@/components/activity-feed";
import { getOverviewStats, getEmotionalTrend, getRecentActivity } from "@/lib/queries/overview";

export default async function OverviewPage() {
  const [stats, trend, activity] = await Promise.all([
    getOverviewStats(),
    getEmotionalTrend(),
    getRecentActivity(),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="font-display text-3xl text-foreground">Overview</h2>
        <p className="mt-1 text-sm text-muted-foreground/70">System status and recent activity</p>
      </div>

      <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={MessageSquare} label="Conversations" value={stats.totalConversations} />
        <StatCard icon={Brain} label="Memories" value={stats.totalMemories} />
        <StatCard icon={Lightbulb} label="Active Facts" value={stats.totalFacts} />
        <StatCard icon={Bell} label="Pending" value={stats.pendingReminders} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-6">
          <div className="mb-6 flex items-center justify-between">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
              Emotional Trend
            </h3>
            <EmotionalIndicator trend={trend} />
          </div>
          {trend.length > 0 ? (
            <div className="space-y-2.5">
              {trend.map((point) => (
                <div key={point.date} className="flex items-center justify-between text-sm">
                  <span className="text-xs tabular-nums text-muted-foreground/50">
                    {point.date}
                  </span>
                  <div className="flex items-center gap-3">
                    <div className="h-1.5 w-28 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${Math.max(0, Math.min(100, (point.avgTone + 1) * 50))}%`,
                          backgroundColor: `oklch(${0.55 + point.avgTone * 0.12} ${0.08 + Math.max(0, point.avgTone) * 0.04} 75)`,
                        }}
                      />
                    </div>
                    <span className="w-10 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                      {point.avgTone}
                    </span>
                    <span className="text-[10px] text-muted-foreground/30">({point.count})</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground/50">No emotional data yet.</p>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card p-6">
          <h3 className="mb-6 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
            Recent Activity
          </h3>
          <ActivityFeed items={activity} />
        </div>
      </div>
    </div>
  );
}
