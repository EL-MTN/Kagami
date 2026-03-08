import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { MemoryListItem } from "@/lib/queries/memories";

interface MemoryCardProps {
  memory: MemoryListItem;
}

function importanceColor(importance?: number): string {
  if (!importance) return "bg-muted text-muted-foreground";
  if (importance >= 8) return "bg-red-500/20 text-red-400";
  if (importance >= 5) return "bg-yellow-500/20 text-yellow-400";
  return "bg-green-500/20 text-green-400";
}

export function MemoryCard({ memory }: MemoryCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{memory.type}</Badge>
          {memory.importance != null && (
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                importanceColor(memory.importance),
              )}
            >
              {memory.importance}/10
            </span>
          )}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {new Date(memory.createdAt).toLocaleDateString()}
        </span>
      </CardHeader>
      <CardContent>
        <p className="whitespace-pre-wrap text-sm">{memory.content}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Source: {memory.source}
        </p>
      </CardContent>
    </Card>
  );
}
