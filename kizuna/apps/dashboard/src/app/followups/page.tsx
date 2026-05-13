import Link from "next/link";
import { revalidatePath } from "next/cache";
import { api } from "@/lib/api";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DataTable, DataRow, type DataTableColumn } from "@/components/shell";
import { TableCell } from "@/components/ui/table";
import type { FollowupDirection, FollowupStatus, ListFollowupsQuery, Person } from "@/lib/types";
import { DirectionBadge, ErrorBlock, PageHeader, PersonLink, StatusBadge } from "../ui";

export const dynamic = "force-dynamic";

type Search = {
  status?: string;
  direction?: string;
  cursor?: string;
};

const PAGE_SIZE = 50;

const COLUMNS: DataTableColumn[] = [
  { key: "direction", label: "Direction", className: "w-[10%]" },
  { key: "person", label: "Person", className: "w-[20%]" },
  { key: "reason", label: "Reason", className: "w-[32%]" },
  { key: "due", label: "Due", className: "w-[14%]" },
  { key: "status", label: "Status", className: "w-[10%]" },
  { key: "actions", label: "", className: "w-[14%]" },
];

// UI exposes a binary status filter (open vs resolved). The API itself
// supports the full {open,done,snoozed,dismissed} enum; "resolved" maps
// to "done" — the most common terminal state for a concierge action.
function resolveStatusFilter(input: string | undefined): FollowupStatus {
  if (input === "resolved" || input === "done") return "done";
  return "open";
}

function isDirection(v: string | undefined): v is FollowupDirection {
  return v === "i_owe" || v === "they_owe";
}

function buildQuery(sp: Search): ListFollowupsQuery {
  const out: ListFollowupsQuery = {
    limit: PAGE_SIZE,
    status: resolveStatusFilter(sp.status),
    sort: "duePriority:1",
  };
  if (isDirection(sp.direction)) out.direction = sp.direction;
  if (sp.cursor) out.cursor = sp.cursor;
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
    params.set(k, String(v));
  }
  const s = params.toString();
  return `/followups${s ? `?${s}` : ""}`;
}

async function resolveFollowupAction(formData: FormData): Promise<void> {
  "use server";
  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) return;
  await api.updateFollowup(id, { status: "done" });
  revalidatePath("/followups");
  revalidatePath("/today");
}

async function deleteFollowupAction(formData: FormData): Promise<void> {
  "use server";
  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) return;
  await api.deleteFollowup(id);
  revalidatePath("/followups");
  revalidatePath("/today");
}

export default async function FollowupsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const query = buildQuery(sp);
  const status = query.status ?? "open";
  const direction = query.direction ?? null;

  let result;
  try {
    result = await api.listFollowups(query);
  } catch (err) {
    return (
      <div className="space-y-6">
        <PageHeader title="Followups" />
        <ErrorBlock
          title="Couldn't load followups"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </div>
    );
  }

  const personIds = [...new Set(result.items.map((f) => f.personId))];
  const people = await Promise.all(personIds.map((id) => api.getPerson(id).catch(() => null)));
  const personById = new Map<string, Person>();
  for (const p of people) if (p) personById.set(p.id, p);

  const empty = emptyMessage(status, direction);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Followups"
        description="What I owe people, and what they owe me. Resolve from the row."
      />

      <form className="flex flex-wrap items-center gap-2" action="/followups" method="get">
        <label className="text-xs text-muted-foreground">Status</label>
        <select
          name="status"
          defaultValue={sp.status === "resolved" ? "resolved" : "open"}
          className="h-9 rounded-md border border-border bg-card px-2 text-sm transition-colors focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/40"
        >
          <option value="open">open</option>
          <option value="resolved">resolved</option>
        </select>
        <label className="ml-2 text-xs text-muted-foreground">Direction</label>
        <select
          name="direction"
          defaultValue={sp.direction ?? ""}
          className="h-9 rounded-md border border-border bg-card px-2 text-sm transition-colors focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/40"
        >
          <option value="">both</option>
          <option value="i_owe">I owe</option>
          <option value="they_owe">they owe</option>
        </select>
        <Button type="submit" variant="outline">
          Apply
        </Button>
        {(sp.status || sp.direction) && (
          <Link
            href="/followups"
            className="self-center text-xs text-faint transition-colors hover:text-muted-foreground"
          >
            clear
          </Link>
        )}
      </form>

      <DataTable columns={COLUMNS} rowCount={result.items.length} empty={empty}>
        {result.items.map((f) => {
          const person = personById.get(f.personId);
          return (
            <DataRow key={f.id}>
              <TableCell>
                <DirectionBadge direction={f.direction} />
              </TableCell>
              <TableCell>
                {person ? (
                  <PersonLink id={person.id} name={person.displayName} />
                ) : (
                  <span className="text-faint">(unknown)</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">{f.reason}</TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                {f.dueAt ? (
                  <span title={fmtDateTime(f.dueAt)}>{fmtRelative(f.dueAt)}</span>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </TableCell>
              <TableCell>
                <StatusBadge status={f.status} />
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-2">
                  {f.status === "open" ? (
                    <form action={resolveFollowupAction}>
                      <input type="hidden" name="id" value={f.id} />
                      <Button type="submit" variant="outline" size="xs">
                        Resolve
                      </Button>
                    </form>
                  ) : null}
                  <form action={deleteFollowupAction}>
                    <input type="hidden" name="id" value={f.id} />
                    <Button type="submit" variant="ghost" size="xs">
                      Delete
                    </Button>
                  </form>
                </div>
              </TableCell>
            </DataRow>
          );
        })}
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

function emptyMessage(status: FollowupStatus, direction: FollowupDirection | null): string {
  const directionPhrase =
    direction === "i_owe"
      ? "where I owe people"
      : direction === "they_owe"
        ? "where they owe me"
        : "";
  if (status === "open") {
    return directionPhrase
      ? `No open followups ${directionPhrase}.`
      : "No open followups. Inbox zero.";
  }
  return directionPhrase
    ? `No resolved followups ${directionPhrase}.`
    : "No resolved followups yet.";
}
