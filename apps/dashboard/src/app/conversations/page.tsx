import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Pagination } from "@/components/pagination";
import { getConversationList } from "@/lib/queries/conversations";

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const { items, total, pageSize } = await getConversationList(page);
  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="font-display text-3xl text-foreground">Conversations</h2>
          <p className="mt-1 text-sm text-muted-foreground/70">Message history and session logs</p>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground/50">{total} total</span>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-border hover:bg-transparent">
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Session
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Status
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Messages
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Platform
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Created
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Updated
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((c) => (
              <TableRow
                key={c.id}
                className="border-border/50 transition-colors hover:bg-primary/[0.02]"
              >
                <TableCell>
                  <Link
                    href={`/conversations/${c.id}`}
                    className="font-mono text-xs text-foreground/60 transition-colors hover:text-primary"
                  >
                    {c.sessionId.slice(0, 8)}...
                  </Link>
                </TableCell>
                <TableCell>
                  <span
                    className={`inline-flex items-center gap-1.5 text-xs ${
                      c.status === "active" ? "text-primary/70" : "text-muted-foreground/50"
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
                <TableCell className="font-mono text-xs tabular-nums text-muted-foreground/60">
                  {c.messageCount}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground/60">{c.platform}</TableCell>
                <TableCell className="text-xs tabular-nums text-muted-foreground/40">
                  {new Date(c.createdAt).toLocaleDateString()}
                </TableCell>
                <TableCell className="text-xs tabular-nums text-muted-foreground/40">
                  {new Date(c.updatedAt).toLocaleDateString()}
                </TableCell>
              </TableRow>
            ))}
            {items.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-12 text-center text-sm text-muted-foreground/50"
                >
                  No conversations found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination currentPage={page} totalPages={totalPages} basePath="/conversations" />
    </div>
  );
}
