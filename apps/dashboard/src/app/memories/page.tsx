import { MemoryCard } from "@/components/memory-card";
import { Pagination } from "@/components/pagination";
import {
  DataToolbar,
  EmptyState,
  LinkFilterPills,
  PageHeader,
  SearchInput,
} from "@/components/shell";
import { getMemoriesByType, getMemoryTypeCounts } from "@/lib/queries/memories";

const MEMORY_TYPES = ["fact", "episode", "milestone", "working"] as const;
const TONES = ["all", "positive", "neutral", "negative"] as const;
const IMPORTANCE = ["all", "low", "medium", "high"] as const;

type MemoryType = (typeof MEMORY_TYPES)[number];
type ToneOption = (typeof TONES)[number];
type ImportanceOption = (typeof IMPORTANCE)[number];

interface MemoryFilters {
  type: MemoryType;
  tone: ToneOption;
  importance: ImportanceOption;
  source: string;
}

function buildHref(overrides: Partial<MemoryFilters>): string {
  const params = new URLSearchParams();
  const next = {
    type: "fact" as MemoryType,
    tone: "all",
    importance: "all",
    source: "",
    ...overrides,
  };
  if (next.type !== "fact") params.set("type", next.type);
  if (next.tone !== "all") params.set("tone", next.tone);
  if (next.importance !== "all") params.set("importance", next.importance);
  if (next.source) params.set("source", next.source);
  const qs = params.toString();
  return qs ? `/memories?${qs}` : "/memories";
}

export default async function MemoriesPage({
  searchParams,
}: {
  searchParams: Promise<{
    type?: string;
    tone?: string;
    importance?: string;
    source?: string;
    page?: string;
  }>;
}) {
  const sp = await searchParams;
  const type: MemoryType = MEMORY_TYPES.includes(sp.type as MemoryType)
    ? (sp.type as MemoryType)
    : "fact";
  const tone: ToneOption = TONES.includes(sp.tone as ToneOption) ? (sp.tone as ToneOption) : "all";
  const importance: ImportanceOption = IMPORTANCE.includes(sp.importance as ImportanceOption)
    ? (sp.importance as ImportanceOption)
    : "all";
  const source = sp.source ?? "";
  const page = Math.max(1, Number(sp.page) || 1);

  const [counts, { items, total, pageSize }] = await Promise.all([
    getMemoryTypeCounts(),
    getMemoriesByType(type, page, {
      tone: tone === "all" ? undefined : tone,
      importance: importance === "all" ? undefined : importance,
      source: source || undefined,
    }),
  ]);

  const totalPages = Math.ceil(total / pageSize);
  const filtered = tone !== "all" || importance !== "all" || source !== "";

  const persistedParams: Record<string, string> = {};
  if (type !== "fact") persistedParams.type = type;
  if (tone !== "all") persistedParams.tone = tone;
  if (importance !== "all") persistedParams.importance = importance;
  if (source) persistedParams.source = source;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Memories"
        description="Stored knowledge and experiences"
        meta={
          <span className="text-xs tabular-nums text-faint">
            {total} {filtered ? "filtered" : type}
          </span>
        }
      />

      <LinkFilterPills<MemoryType>
        active={type}
        options={MEMORY_TYPES.map((t) => ({
          value: t,
          label: t,
          count: counts[t],
          href: buildHref({ type: t, tone, importance, source }),
        }))}
      />

      <DataToolbar
        filters={
          <>
            <SearchInput param="source" placeholder="Filter by source" />
            <LinkFilterPills<ToneOption>
              active={tone}
              options={TONES.map((v) => ({
                value: v,
                label: v,
                href: buildHref({ type, tone: v, importance, source }),
              }))}
            />
            <LinkFilterPills<ImportanceOption>
              active={importance}
              options={IMPORTANCE.map((v) => ({
                value: v,
                label: v,
                href: buildHref({ type, tone, importance: v, source }),
              }))}
            />
          </>
        }
      />

      {items.length > 0 ? (
        <div className="stagger space-y-4">
          {items.map((memory) => (
            <MemoryCard key={memory.id} memory={memory} />
          ))}
        </div>
      ) : (
        <EmptyState>
          {filtered
            ? `No ${type} memories match the current filters.`
            : `No ${type} memories found.`}
        </EmptyState>
      )}

      <Pagination
        currentPage={page}
        totalPages={totalPages}
        basePath="/memories"
        searchParams={persistedParams}
      />
    </div>
  );
}
