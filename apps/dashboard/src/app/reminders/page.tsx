import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getReminderList } from "@/lib/queries/reminders";

export default async function RemindersPage({
  searchParams,
}: {
  searchParams: Promise<{ showFired?: string }>;
}) {
  const { showFired: showFiredParam } = await searchParams;
  const showFired = showFiredParam === "true";
  const items = await getReminderList(showFired);
  const now = new Date();

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="font-display text-3xl text-foreground">Reminders</h2>
          <p className="mt-1 text-sm text-muted-foreground/70">
            Scheduled notifications and alerts
          </p>
        </div>
        <Button variant="ghost" size="sm" asChild className="text-xs text-muted-foreground">
          <Link href={`/reminders?showFired=${!showFired}`}>
            {showFired ? "Hide fired" : "Show fired"}
          </Link>
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-border hover:bg-transparent">
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Message
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Fire Time
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Status
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Chat ID
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Created
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((r) => {
              const status = r.fired ? "fired" : new Date(r.fireAt) < now ? "expired" : "pending";
              return (
                <TableRow
                  key={r.id}
                  className="border-border/50 transition-colors hover:bg-primary/[0.02]"
                >
                  <TableCell className="max-w-xs truncate text-sm text-foreground/80">
                    {r.message}
                  </TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground/60">
                    {new Date(r.fireAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center gap-1.5 text-xs ${
                        status === "pending"
                          ? "text-primary/70"
                          : status === "fired"
                            ? "text-muted-foreground/50"
                            : "text-destructive-foreground"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          status === "pending"
                            ? "bg-primary/70"
                            : status === "fired"
                              ? "bg-muted-foreground/20"
                              : "bg-destructive/50"
                        }`}
                      />
                      {status}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground/40">
                    {r.chatId}
                  </TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground/40">
                    {new Date(r.createdAt).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              );
            })}
            {items.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-12 text-center text-sm text-muted-foreground/50"
                >
                  No reminders found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
