import Link from "next/link";
import { MessageSquare, Brain } from "lucide-react";
import type { RecentActivityItem } from "@/lib/queries/overview";

interface ActivityFeedProps {
  items: RecentActivityItem[];
}

function formatRelative(date: Date): string {
  const ms = Date.now() - date.getTime();
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  return `${weeks}w ago`;
}

export function ActivityFeed({ items }: ActivityFeedProps) {
  if (items.length === 0) {
    return <p className="text-sm text-faint">No recent activity.</p>;
  }

  return (
    <ol className="relative space-y-0">
      {/* Timeline line */}
      <div className="absolute bottom-3 left-[11px] top-3 w-px bg-border" />

      {items.map((item) => {
        const isConvo = item.type === "conversation";
        return (
          <li key={`${item.type}-${item.id}`} className="relative flex gap-3 py-2.5">
            <div className="relative z-10 mt-1 flex h-[22px] w-[22px] shrink-0 items-center justify-center">
              {isConvo ? (
                <span
                  className="flex h-[22px] w-[22px] items-center justify-center rounded-full border border-primary/40 bg-primary/10 text-primary"
                  aria-label="conversation"
                >
                  <MessageSquare className="h-3 w-3" strokeWidth={2} />
                </span>
              ) : (
                <span
                  className="flex h-[22px] w-[22px] items-center justify-center rounded-full border border-border bg-card text-muted-foreground"
                  aria-label="memory"
                >
                  <Brain className="h-3 w-3" strokeWidth={1.75} />
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                {isConvo ? (
                  <Link
                    href={`/conversations/${item.id}`}
                    className="truncate text-sm text-foreground transition-colors hover:text-primary"
                  >
                    {item.summary}
                  </Link>
                ) : (
                  <p className="truncate text-sm text-foreground">{item.summary}</p>
                )}
                <span
                  className="shrink-0 text-[11px] tabular-nums text-faint"
                  title={item.timestamp.toLocaleString()}
                >
                  {formatRelative(item.timestamp)}
                </span>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
