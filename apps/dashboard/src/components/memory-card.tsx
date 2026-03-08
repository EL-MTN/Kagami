import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { MemoryListItem } from "@/lib/queries/memories";

interface MemoryCardProps {
  memory: MemoryListItem;
}

function importanceVariant(importance?: number): "default" | "secondary" | "destructive" {
  if (!importance || importance < 5) return "secondary";
  if (importance >= 8) return "destructive";
  return "default";
}

export function MemoryCard({ memory }: MemoryCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{memory.type}</Badge>
          {memory.importance != null && (
            <Badge variant={importanceVariant(memory.importance)}>
              {memory.importance}/10
            </Badge>
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
