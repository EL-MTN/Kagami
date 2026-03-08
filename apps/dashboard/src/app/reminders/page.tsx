import { Badge } from "@/components/ui/badge";
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Reminders</h2>
        <a
          href={`/reminders?showFired=${!showFired}`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          {showFired ? "Hide fired" : "Show fired"}
        </a>
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Message</TableHead>
              <TableHead>Fire Time</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Chat ID</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="max-w-xs truncate">{r.message}</TableCell>
                <TableCell className="text-sm">
                  {new Date(r.fireAt).toLocaleString()}
                </TableCell>
                <TableCell>
                  {r.fired ? (
                    <Badge variant="secondary">fired</Badge>
                  ) : new Date(r.fireAt) < now ? (
                    <Badge variant="destructive">expired</Badge>
                  ) : (
                    <Badge variant="default">pending</Badge>
                  )}
                </TableCell>
                <TableCell className="font-mono text-sm">{r.chatId}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {new Date(r.createdAt).toLocaleDateString()}
                </TableCell>
              </TableRow>
            ))}
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
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
