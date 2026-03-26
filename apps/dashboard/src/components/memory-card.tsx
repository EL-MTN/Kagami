import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { MemoryListItem } from "@/lib/queries/memories";

interface MemoryCardProps {
  memory: MemoryListItem;
}

const typeColors: Record<string, string> = {
  fact: "bg-primary",
  episode: "bg-blue-400/70",
  milestone: "bg-amber-400/70",
  working: "bg-muted-foreground/40",
};

function barColor(importance?: number): string {
  if (!importance || importance < 4) return "bg-muted-foreground/20";
  if (importance < 7) return "bg-primary/50";
  return "bg-primary";
}

export function MemoryCard({ memory }: MemoryCardProps) {
  return (
    <Card className="transition-all duration-200 hover:border-primary/15">
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${typeColors[memory.type] ?? "bg-muted-foreground/40"}`}
            />
            {memory.type}
          </span>
          {memory.importance != null && (
            <div className="flex items-center gap-1.5">
              <div className="flex gap-px">
                {Array.from({ length: 10 }, (_, i) => (
                  <div
                    key={i}
                    className={`h-1.5 w-1 rounded-full ${i < memory.importance! ? barColor(memory.importance) : "bg-muted"}`}
                  />
                ))}
              </div>
              <span className="text-[10px] tabular-nums text-muted-foreground/50">
                {memory.importance}
              </span>
            </div>
          )}
        </div>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/40">
          {new Date(memory.createdAt).toLocaleDateString()}
        </span>
      </CardHeader>
      <CardContent>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
          {memory.content}
        </p>
        <p className="mt-3 text-[10px] uppercase tracking-[0.15em] text-muted-foreground/40">
          {memory.source}
        </p>
      </CardContent>
    </Card>
  );
}
