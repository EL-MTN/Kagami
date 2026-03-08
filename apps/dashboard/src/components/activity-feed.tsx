import Link from "next/link";
import { MessageSquare, Brain } from "lucide-react";
import type { RecentActivityItem } from "@/lib/queries/overview";

interface ActivityFeedProps {
  items: RecentActivityItem[];
}

export function ActivityFeed({ items }: ActivityFeedProps) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No recent activity.</p>;
  }

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div key={`${item.type}-${item.id}`} className="flex items-start gap-3">
          <div className="mt-0.5 rounded-md bg-secondary p-1.5">
            {item.type === "conversation" ? (
              <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <Brain className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            {item.type === "conversation" ? (
              <Link
                href={`/conversations/${item.id}`}
                className="text-sm font-medium hover:text-primary"
              >
                {item.summary}
              </Link>
            ) : (
              <p className="text-sm">{item.summary}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {item.timestamp.toLocaleString()}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
