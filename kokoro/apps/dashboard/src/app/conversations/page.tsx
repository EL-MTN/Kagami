import Link from "next/link";
import { TableCell } from "@/components/ui/table";
import { Pagination } from "@/components/pagination";
import {
  DataRow,
  DataTable,
  DataToolbar,
  LinkFilterPills,
  PageHeader,
  SearchInput,
  type DataTableColumn,
} from "@/components/shell";
import { getConversationList } from "@/lib/queries/conversations";

const STATUSES = ["all", "active", "closed"] as const;
type StatusFilter = (typeof STATUSES)[number];

const COLUMNS: DataTableColumn[] = [
  { key: "session", label: "Session" },
  { key: "chat", label: "Chat" },
  { key: "status", label: "Status" },
  { key: "messages", label: "Messages" },
  { key: "platform", label: "Platform" },
  { key: "created", label: "Created" },
  { key: "updated", label: "Updated" },
];

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string; q?: string }>;
}) {
  const { page: pageParam, status: statusParam, q } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const status: StatusFilter = STATUSES.includes(statusParam as StatusFilter)
    ? (statusParam as StatusFilter)
    : "all";

  const { items, total, pageSize } = await getConversationList(page, {
    status: status === "all" ? undefined : status,
    search: q || undefined,
  });
  const totalPages = Math.ceil(total / pageSize);

  function buildHref(nextStatus: StatusFilter): string {
    const params = new URLSearchParams();
    if (nextStatus !== "all") params.set("status", nextStatus);
    if (q) params.set("q", q);
    const qs = params.toString();
    return qs ? `/conversations?${qs}` : "/conversations";
  }

  const statusOptions = STATUSES.map((v) => ({
    value: v,
    label: v,
    href: buildHref(v),
  }));

  return (
    <div className="space-y-8">
      <PageHeader
        title="Conversations"
        description="Message history and session logs"
        meta={<span className="text-xs tabular-nums text-faint">{total} total</span>}
      />

      <DataToolbar
        filters={
          <>
            <SearchInput param="q" placeholder="Search by chat ID" />
            <LinkFilterPills<StatusFilter> options={statusOptions} active={status} />
          </>
        }
      />

      <DataTable columns={COLUMNS} rowCount={items.length} empty="No conversations found.">
        {items.map((c) => (
          <DataRow key={c.id}>
            <TableCell>
              <Link
                href={`/conversations/${c.id}`}
                className="font-mono text-xs text-foreground/60 transition-colors hover:text-primary"
              >
                {c.sessionId.slice(0, 8)}...
              </Link>
            </TableCell>
            <TableCell className="font-mono text-xs text-faint">{c.chatId}</TableCell>
            <TableCell>
              <span
                className={`inline-flex items-center gap-1.5 text-xs ${
                  c.status === "active" ? "text-primary/70" : "text-faint"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    c.status === "active" ? "bg-primary/70" : "bg-muted-foreground/20"
                  }`}
                />
                {c.status}
              </span>
            </TableCell>
            <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
              {c.messageCount}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">{c.platform}</TableCell>
            <TableCell className="text-xs tabular-nums text-faint">
              {new Date(c.createdAt).toLocaleDateString()}
            </TableCell>
            <TableCell className="text-xs tabular-nums text-faint">
              {new Date(c.updatedAt).toLocaleDateString()}
            </TableCell>
          </DataRow>
        ))}
      </DataTable>

      <Pagination
        currentPage={page}
        totalPages={totalPages}
        basePath="/conversations"
        searchParams={{
          ...(status !== "all" ? { status } : {}),
          ...(q ? { q } : {}),
        }}
      />
    </div>
  );
}
