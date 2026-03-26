import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MemoryCard } from "@/components/memory-card";
import { Pagination } from "@/components/pagination";
import { getMemoriesByType, getMemoryTypeCounts } from "@/lib/queries/memories";

const MEMORY_TYPES = ["fact", "episode", "milestone", "working"] as const;

export default async function MemoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; page?: string }>;
}) {
  const { type: typeParam, page: pageParam } = await searchParams;
  const activeType = MEMORY_TYPES.includes(typeParam as (typeof MEMORY_TYPES)[number])
    ? (typeParam as (typeof MEMORY_TYPES)[number])
    : "fact";
  const page = Math.max(1, Number(pageParam) || 1);

  const [counts, { items, total, pageSize }] = await Promise.all([
    getMemoryTypeCounts(),
    getMemoriesByType(activeType, page),
  ]);

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="font-display text-3xl text-foreground">Memories</h2>
          <p className="mt-1 text-sm text-muted-foreground/70">Stored knowledge and experiences</p>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground/50">
          {total} {activeType}s
        </span>
      </div>

      <Tabs defaultValue={activeType}>
        <TabsList>
          {MEMORY_TYPES.map((type) => (
            <TabsTrigger key={type} value={type} asChild>
              <a href={`/memories?type=${type}`} className="gap-2 capitalize">
                {type}
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground/60">
                  {counts[type]}
                </span>
              </a>
            </TabsTrigger>
          ))}
        </TabsList>

        {MEMORY_TYPES.map((type) => (
          <TabsContent key={type} value={type}>
            {type === activeType && (
              <div className="stagger space-y-4">
                {items.map((memory) => (
                  <MemoryCard key={memory.id} memory={memory} />
                ))}
                {items.length === 0 && (
                  <p className="py-12 text-center text-sm text-muted-foreground/50">
                    No {type} memories found.
                  </p>
                )}
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>

      <Pagination
        currentPage={page}
        totalPages={totalPages}
        basePath="/memories"
        searchParams={{ type: activeType }}
      />
    </div>
  );
}
