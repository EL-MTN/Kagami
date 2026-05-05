import Link from "next/link";
import { api } from "@/lib/api";
import { fmtRelative } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DataTable, DataRow, type DataTableColumn } from "@/components/shell";
import { TableCell } from "@/components/ui/table";
import { Badge, ErrorBlock, Mono, PageHeader, PersonLink } from "../ui";
import type { ListPeopleQuery } from "@/lib/types";

export const dynamic = "force-dynamic";

type Search = {
  q?: string;
  source?: string;
  tag?: string | string[];
  cursor?: string;
  includeTombstoned?: string;
};

const PAGE_SIZE = 50;

const COLUMNS: DataTableColumn[] = [
  { key: "name", label: "Name", className: "w-[28%]" },
  { key: "email", label: "Email", className: "w-[26%]" },
  { key: "tags", label: "Tags", className: "w-[20%]" },
  { key: "last", label: "Last interaction", className: "w-[14%]" },
  { key: "source", label: "Source", className: "w-[12%]" },
];

function buildQuery(sp: Search): ListPeopleQuery {
  const tag = sp.tag ? (Array.isArray(sp.tag) ? sp.tag : [sp.tag]) : undefined;
  const out: ListPeopleQuery = {
    limit: PAGE_SIZE,
    sort: "lastInteractionAt:-1",
  };
  if (sp.q) out.query = sp.q;
  if (sp.source) out.source = sp.source;
  if (tag) out.tag = tag;
  if (sp.cursor) out.cursor = sp.cursor;
  if (sp.includeTombstoned === "true") out.includeTombstoned = true;
  return out;
}

function buildHref(
  sp: Search,
  overrides: Omit<Partial<Search>, "cursor"> & { cursor?: string | null },
): string {
  const params = new URLSearchParams();
  const merged: Search = { ...sp };
  for (const [k, v] of Object.entries(overrides)) {
    if (k === "cursor" && v === null) {
      delete merged.cursor;
    } else if (v !== undefined) {
      (merged as Record<string, unknown>)[k] = v;
    }
  }
  for (const [k, v] of Object.entries(merged)) {
    if (v == null || v === "") continue;
    if (Array.isArray(v)) for (const x of v) params.append(k, x);
    else params.set(k, String(v));
  }
  const s = params.toString();
  return `/people${s ? `?${s}` : ""}`;
}

export default async function PeoplePage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const query = buildQuery(sp);

  let result;
  try {
    result = await api.listPeople(query);
  } catch (err) {
    return (
      <div className="space-y-6">
        <PageHeader title="People" />
        <ErrorBlock
          title="Couldn't load people"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </div>
    );
  }

  const tags = sp.tag ? (Array.isArray(sp.tag) ? sp.tag : [sp.tag]) : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="People"
        description="Sorted by most recent interaction. Filter via the querystring."
      />

      <form className="flex flex-wrap items-center gap-2" action="/people" method="get">
        <input
          name="q"
          defaultValue={sp.q ?? ""}
          placeholder="search name / notes / tags"
          className="h-9 w-72 rounded-md border border-border bg-card px-3 text-sm shadow-xs placeholder:text-faint transition-colors focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/40"
        />
        <select
          name="source"
          defaultValue={sp.source ?? ""}
          className="h-9 rounded-md border border-border bg-card px-2 text-sm transition-colors focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/40"
        >
          <option value="">any source</option>
          <option value="concierge">concierge</option>
          <option value="gmail-sync">gmail-sync</option>
          <option value="gcal-sync">gcal-sync</option>
          <option value="manual">manual</option>
          <option value="import">import</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            name="includeTombstoned"
            value="true"
            defaultChecked={sp.includeTombstoned === "true"}
            className="accent-primary"
          />
          include tombstoned
        </label>
        <Button type="submit" variant="outline">
          Apply
        </Button>
        {(sp.q || sp.source || sp.includeTombstoned || tags.length > 0) && (
          <Link
            href="/people"
            className="self-center text-xs text-faint transition-colors hover:text-muted-foreground"
          >
            clear
          </Link>
        )}
      </form>

      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-faint">filter tags:</span>
          {tags.map((t) => (
            <Link
              key={t}
              href={buildHref(sp, { tag: tags.filter((x) => x !== t) })}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-muted-foreground transition-colors hover:bg-accent"
            >
              {t} <span className="text-faint">×</span>
            </Link>
          ))}
        </div>
      )}

      <DataTable
        columns={COLUMNS}
        rowCount={result.items.length}
        empty="No people match these filters."
      >
        {result.items.map((p) => (
          <DataRow key={p.id}>
            <TableCell className={p.deletedAt ? "opacity-50" : undefined}>
              <div className="flex items-center gap-2">
                <PersonLink id={p.id} name={p.displayName} />
                {p.deletedAt ? <Badge tone="red">tombstoned</Badge> : null}
              </div>
            </TableCell>
            <TableCell className="text-muted-foreground">{p.primaryEmail ?? "—"}</TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {p.tags.length === 0
                  ? "—"
                  : p.tags.map((t) => (
                      <Link
                        key={t}
                        href={buildHref(sp, {
                          tag: [...new Set([...tags, t])],
                          cursor: null,
                        })}
                        className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
                      >
                        {t}
                      </Link>
                    ))}
              </div>
            </TableCell>
            <TableCell className="text-muted-foreground tabular-nums">
              {fmtRelative(p.lastInteractionAt)}
            </TableCell>
            <TableCell>
              <Mono>{p.source}</Mono>
            </TableCell>
          </DataRow>
        ))}
      </DataTable>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span className="tabular-nums">{result.items.length} shown</span>
        {result.nextCursor ? (
          <Button variant="outline" asChild>
            <Link href={buildHref(sp, { cursor: result.nextCursor })}>Next page →</Link>
          </Button>
        ) : (
          <span className="text-faint">end of results</span>
        )}
      </div>
    </div>
  );
}
