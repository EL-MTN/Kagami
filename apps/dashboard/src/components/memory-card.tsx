import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { MemoryListItem } from "@/lib/queries/memories";

interface MemoryCardProps {
  memory: MemoryListItem;
}

const typeColors: Record<string, string> = {
  fact: "bg-primary",
  episode: "bg-positive",
  milestone: "bg-caution",
  working: "bg-muted-foreground",
};

function barColor(importance?: number): string {
  if (!importance || importance < 4) return "bg-rule-strong";
  if (importance < 7) return "bg-primary/60";
  return "bg-primary";
}

export function MemoryCard({ memory }: MemoryCardProps) {
  return (
    <Card className="transition-colors hover:border-rule-strong">
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${typeColors[memory.type] ?? "bg-muted-foreground"}`}
            />
            {memory.type}
          </span>
          {memory.importance != null && (
            <div className="flex items-center gap-1.5">
              <div className="flex gap-px">
                {Array.from({ length: 10 }, (_, i) => (
                  <div
                    key={i}
                    className={`h-2 w-1 rounded-sm ${i < memory.importance! ? barColor(memory.importance) : "bg-muted"}`}
                  />
                ))}
              </div>
              <span className="font-mono text-[10px] tabular-nums text-faint">
                {memory.importance}
              </span>
            </div>
          )}
        </div>
        <span
          className="shrink-0 font-mono text-[11px] tabular-nums text-faint"
          title={new Date(memory.createdAt).toLocaleString()}
        >
          {new Date(memory.createdAt).toLocaleDateString()}
        </span>
      </CardHeader>
      <CardContent>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {memory.content}
        </p>
        <p className="mt-3 text-[11px] text-faint">{memory.source}</p>
      </CardContent>
    </Card>
  );
}
