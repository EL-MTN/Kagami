import Link from "next/link";
import { MessageSquare, Brain, Lightbulb, Bell, ArrowRight, AlertCircle } from "lucide-react";
import { StatCard } from "@/components/stat-card";
import { EmotionalIndicator } from "@/components/emotional-indicator";
import { ActivityFeed } from "@/components/activity-feed";
import { ConfirmationCard } from "@/components/confirmation-card";
import { Sparkline } from "@/components/sparkline";
import { PageHeader } from "@/components/shell";
import { getOverviewStats, getEmotionalTrend, getRecentActivity } from "@/lib/queries/overview";
import { getPendingConfirmationList } from "@/lib/queries/confirmations";

export default async function OverviewPage() {
  const [stats, trend, activity, pending] = await Promise.all([
    getOverviewStats(),
    getEmotionalTrend(),
    getRecentActivity(),
    getPendingConfirmationList(),
  ]);

  const pendingPreview = pending.slice(0, 3);
  const pendingExtra = pending.length - pendingPreview.length;

  // Trend direction for sparkline color
  const recent = trend.slice(-3);
  const older = trend.slice(0, -3);
  const recentAvg = recent.length ? recent.reduce((s, p) => s + p.avgTone, 0) / recent.length : 0;
  const olderAvg = older.length
    ? older.reduce((s, p) => s + p.avgTone, 0) / older.length
    : recentAvg;
  const diff = recentAvg - olderAvg;
  const sparkColor =
    diff > 0.3
      ? "var(--color-positive)"
      : diff < -0.3
        ? "var(--color-critical)"
        : "var(--color-muted-foreground)";

  return (
    <div className="space-y-8">
      <PageHeader
        title="Overview"
        description="System status and recent activity"
        meta={
          pending.length > 0 ? (
            <Link
              href="/confirmations"
              className="inline-flex items-center gap-2 rounded-md border border-caution/30 bg-caution/10 px-3 py-1.5 text-xs font-medium text-caution transition-colors hover:bg-caution/15"
            >
              <AlertCircle className="h-3.5 w-3.5" />
              {pending.length} pending {pending.length === 1 ? "approval" : "approvals"}
            </Link>
          ) : undefined
        }
      />

      {pending.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h3 className="kicker">Pending intent</h3>
            <Link
              href="/confirmations"
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-primary"
            >
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <div className="space-y-2.5">
            {pendingPreview.map((item) => (
              <ConfirmationCard key={item.id} item={item} />
            ))}
            {pendingExtra > 0 && (
              <Link
                href="/confirmations"
                className="block rounded-lg border border-dashed border-border bg-card px-5 py-2.5 text-center text-xs text-muted-foreground transition-colors hover:border-rule-strong hover:text-foreground"
              >
                + {pendingExtra} more pending
              </Link>
            )}
          </div>
        </section>
      )}

      <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={MessageSquare} label="Conversations" value={stats.totalConversations} />
        <StatCard icon={Brain} label="Memories" value={stats.totalMemories} />
        <StatCard icon={Lightbulb} label="Active facts" value={stats.totalFacts} />
        <StatCard
          icon={Bell}
          label="Pending"
          value={stats.pendingReminders}
          hint={stats.pendingReminders > 0 ? "reminders awaiting" : undefined}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="kicker">Emotional trend</h3>
            <EmotionalIndicator trend={trend} />
          </div>
          {trend.length > 0 ? (
            <div className="space-y-4">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <div className="font-mono text-[28px] font-medium leading-none tabular-nums text-foreground">
                    {(trend.reduce((s, p) => s + p.avgTone, 0) / trend.length).toFixed(2)}
                  </div>
                  <div className="mt-1.5 text-[11px] text-faint">
                    avg over {trend.length} {trend.length === 1 ? "day" : "days"}
                  </div>
                </div>
                <Sparkline
                  values={trend.map((p) => p.avgTone)}
                  width={200}
                  height={48}
                  stroke={sparkColor}
                  domain={[-1, 1]}
                  baseline={0}
                  ariaLabel="Emotional tone over time"
                />
              </div>
              <div className="flex items-center justify-between border-t border-border pt-3 text-[10px] tabular-nums text-faint">
                <span>{trend[0].date}</span>
                <span>{trend.reduce((s, p) => s + p.count, 0)} samples</span>
                <span>{trend[trend.length - 1].date}</span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-faint">No emotional data yet.</p>
          )}
        </div>

        <div className="rounded-lg border border-border bg-card p-5">
          <h3 className="kicker mb-4">Recent activity</h3>
          <ActivityFeed items={activity} />
        </div>
      </div>
    </div>
  );
}
