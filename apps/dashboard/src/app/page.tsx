import Link from "next/link";
import { MessageSquare, Bell, ArrowRight, AlertCircle } from "lucide-react";
import { StatCard } from "@/components/stat-card";
import { ActivityFeed } from "@/components/activity-feed";
import { ConfirmationCard } from "@/components/confirmation-card";
import { PageHeader } from "@/components/shell";
import { getOverviewStats, getRecentActivity } from "@/lib/queries/overview";
import { getPendingConfirmationList } from "@/lib/queries/confirmations";

export default async function OverviewPage() {
  const [stats, activity, pending] = await Promise.all([
    getOverviewStats(),
    getRecentActivity(),
    getPendingConfirmationList(),
  ]);

  const pendingPreview = pending.slice(0, 3);
  const pendingExtra = pending.length - pendingPreview.length;

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

      <div className="stagger grid gap-3 sm:grid-cols-2">
        <StatCard icon={MessageSquare} label="Conversations" value={stats.totalConversations} />
        <StatCard
          icon={Bell}
          label="Pending"
          value={stats.pendingReminders}
          hint={stats.pendingReminders > 0 ? "reminders awaiting" : undefined}
        />
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <h3 className="kicker mb-4">Recent activity</h3>
        <ActivityFeed items={activity} />
      </div>
    </div>
  );
}
