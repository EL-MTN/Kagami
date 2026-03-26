import Link from "next/link";
import { MessageSquare, Brain } from "lucide-react";
import type { RecentActivityItem } from "@/lib/queries/overview";

interface ActivityFeedProps {
  items: RecentActivityItem[];
}

export function ActivityFeed({ items }: ActivityFeedProps) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground/60">No recent activity.</p>;
  }

  return (
    <div className="relative space-y-0">
      {/* Timeline line */}
      <div className="absolute bottom-3 left-[15px] top-3 w-px bg-border" />

      {items.map((item) => (
        <div key={`${item.type}-${item.id}`} className="relative flex gap-4 py-3">
          <div
            className={`relative z-10 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${
              item.type === "conversation"
                ? "border-primary/25 bg-primary/5"
                : "border-border bg-card"
            }`}
          >
            {item.type === "conversation" ? (
              <MessageSquare className="h-3.5 w-3.5 text-primary/60" />
            ) : (
              <Brain className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            {item.type === "conversation" ? (
              <Link
                href={`/conversations/${item.id}`}
                className="text-sm text-foreground/90 transition-colors hover:text-primary"
              >
                {item.summary}
              </Link>
            ) : (
              <p className="text-sm text-foreground/80">{item.summary}</p>
            )}
            <p className="mt-0.5 text-[10px] text-muted-foreground/50">
              {item.timestamp.toLocaleString()}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
