import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Memories</h2>
        <span className="text-sm text-muted-foreground">{total} {activeType}s</span>
      </div>

      <Tabs defaultValue={activeType}>
        <TabsList>
          {MEMORY_TYPES.map((type) => (
            <TabsTrigger key={type} value={type} asChild>
              <a href={`/memories?type=${type}`} className="capitalize">
                {type}
                <Badge variant="secondary" className="ml-2">
                  {counts[type]}
                </Badge>
              </a>
            </TabsTrigger>
          ))}
        </TabsList>

        {MEMORY_TYPES.map((type) => (
          <TabsContent key={type} value={type}>
            {type === activeType && (
              <div className="space-y-4">
                {items.map((memory) => (
                  <MemoryCard key={memory.id} memory={memory} />
                ))}
                {items.length === 0 && (
                  <p className="text-center text-sm text-muted-foreground py-8">
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
