import { MessageSquare, Brain, Lightbulb, Bell } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Overview</h2>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={MessageSquare} label="Conversations" value={stats.totalConversations} />
        <StatCard icon={Brain} label="Memories" value={stats.totalMemories} />
        <StatCard icon={Lightbulb} label="Facts" value={stats.totalFacts} />
        <StatCard icon={Bell} label="Pending Reminders" value={stats.pendingReminders} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Emotional Trend</CardTitle>
              <EmotionalIndicator trend={trend} />
            </div>
          </CardHeader>
          <CardContent>
            {trend.length > 0 ? (
              <div className="space-y-2">
                {trend.map((point) => (
                  <div key={point.date} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{point.date}</span>
                    <div className="flex items-center gap-3">
                      <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${Math.max(0, Math.min(100, (point.avgTone + 1) * 50))}%` }}
                        />
                      </div>
                      <span className="w-10 text-right font-mono text-xs">{point.avgTone}</span>
                      <span className="text-xs text-muted-foreground">({point.count})</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No emotional data yet.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <ActivityFeed items={activity} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
