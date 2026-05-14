import Link from "next/link";
import { api } from "@/lib/api";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DataTable, DataRow, type DataTableColumn } from "@/components/shell";
import { TableCell } from "@/components/ui/table";
import type { Channel, ListInteractionsQuery, Person } from "@/lib/types";
import { ChannelBadge, ErrorBlock, Mono, PageHeader, PersonLink } from "../ui";
import { Filters } from "./filters";

export const dynamic = "force-dynamic";

type Search = {
  channel?: string;
  personId?: string;
  cursor?: string;
};

const PAGE_SIZE = 50;

const CHANNEL_SET: ReadonlySet<Channel> = new Set([
  "email",
  "calendar",
  "in_person",
  "call",
  "message",
  "manual",
]);

const COLUMNS: DataTableColumn[] = [
  { key: "channel", label: "Channel", className: "w-[10%]" },
  { key: "title", label: "Title", className: "w-[34%]" },
  { key: "participants", label: "Participants", className: "w-[26%]" },
  { key: "occurredAt", label: "When", className: "w-[18%]" },
  { key: "source", label: "Source", className: "w-[12%]" },
];

function isChannel(v: string | undefined): v is Channel {
  return typeof v === "string" && CHANNEL_SET.has(v as Channel);
}

function buildQuery(sp: Search): ListInteractionsQuery {
  const out: ListInteractionsQuery = {
    limit: PAGE_SIZE,
    sort: "occurredAt:-1",
  };
  if (isChannel(sp.channel)) out.channel = sp.channel;
  if (sp.personId) out.personId = sp.personId;
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
  return `/interactions${s ? `?${s}` : ""}`;
}

export default async function InteractionsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const query = buildQuery(sp);

  let result;
  try {
    result = await api.listInteractions(query);
  } catch (err) {
    return (
      <div className="space-y-6">
        <PageHeader title="Interactions" />
        <ErrorBlock
          title="Couldn't load interactions"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </div>
    );
  }

  // Hydrate participants and (if filtering) the person header chip in one batch.
  const participantIds = new Set<string>();
  for (const i of result.items) for (const p of i.participants) participantIds.add(p.personId);
  if (sp.personId) participantIds.add(sp.personId);
  const people = await Promise.all(
    [...participantIds].map((id) => api.getPerson(id).catch(() => null)),
  );
  const personById = new Map<string, Person>();
  for (const p of people) if (p) personById.set(p.id, p);

  const initialPerson = sp.personId
    ? (personById.get(sp.personId) ?? { id: sp.personId, displayName: "(unknown)" })
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Interactions"
        description="All recorded touchpoints, newest first. Filter by channel or person."
      />

      <Filters
        initialChannel={isChannel(sp.channel) ? sp.channel : ""}
        initialPerson={
          initialPerson ? { id: initialPerson.id, displayName: initialPerson.displayName } : null
        }
        basePath="/interactions"
      />

      <DataTable
        columns={COLUMNS}
        rowCount={result.items.length}
        empty={emptyMessage(sp.channel, sp.personId, initialPerson?.displayName)}
      >
        {result.items.map((i) => {
          const names = i.participants.slice(0, 3).map((p) => {
            const person = personById.get(p.personId);
            return person ? (
              <PersonLink key={p.personId} id={person.id} name={person.displayName} />
            ) : (
              <span key={p.personId} className="text-faint">
                ?
              </span>
            );
          });
          const more = i.participants.length > 3 ? ` +${i.participants.length - 3}` : "";
          return (
            <DataRow key={i.id}>
              <TableCell>
                <ChannelBadge channel={i.channel} />
              </TableCell>
              <TableCell>
                <div className="truncate text-sm font-medium text-foreground">{i.title}</div>
                {i.body ? (
                  <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{i.body}</div>
                ) : null}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  {names.length === 0 ? (
                    <span className="text-faint">—</span>
                  ) : (
                    names.map((node, idx) => (
                      <span key={idx} className="inline-flex items-center gap-1">
                        {node}
                        {idx < names.length - 1 ? <span className="text-faint">,</span> : null}
                      </span>
                    ))
                  )}
                  {more ? <span className="text-faint">{more}</span> : null}
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                <div title={fmtDateTime(i.occurredAt)}>{fmtRelative(i.occurredAt)}</div>
              </TableCell>
              <TableCell>
                <Mono>{i.source}</Mono>
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

function emptyMessage(
  channel: string | undefined,
  personId: string | undefined,
  personName: string | undefined,
): string {
  const parts: string[] = [];
  if (channel) parts.push(`channel = ${channel}`);
  if (personId) parts.push(`person = ${personName ?? personId}`);
  if (parts.length === 0) {
    return "No interactions yet. Run an ingest worker or POST one.";
  }
  return `No interactions match ${parts.join(" · ")}.`;
}
