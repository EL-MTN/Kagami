import { TableCell } from "@/components/ui/table";
import {
  DataRow,
  DataTable,
  LinkFilterPills,
  PageHeader,
  type DataTableColumn,
} from "@/components/shell";
import { getReminderList } from "@/lib/queries/reminders";

const VIEWS = ["pending", "fired", "all"] as const;
type View = (typeof VIEWS)[number];

const COLUMNS: DataTableColumn[] = [
  { key: "message", label: "Message" },
  { key: "fireAt", label: "Fire Time" },
  { key: "status", label: "Status" },
  { key: "chatId", label: "Chat ID" },
  { key: "createdAt", label: "Created" },
];

export default async function RemindersPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view: viewParam } = await searchParams;
  const view: View = VIEWS.includes(viewParam as View) ? (viewParam as View) : "pending";

  const all = await getReminderList(true);
  const now = new Date();

  const visible = all.filter((r) => {
    if (view === "all") return true;
    if (view === "fired") return r.fired;
    return !r.fired;
  });

  const counts = {
    pending: all.filter((r) => !r.fired).length,
    fired: all.filter((r) => r.fired).length,
    all: all.length,
  };

  return (
    <div className="space-y-8">
      <PageHeader
        title="Reminders"
        description="Scheduled notifications and alerts"
        meta={<span className="text-xs tabular-nums text-faint">{visible.length}</span>}
      />

      <LinkFilterPills<View>
        active={view}
        options={[
          { value: "pending", label: "pending", count: counts.pending, href: "/reminders" },
          { value: "fired", label: "fired", count: counts.fired, href: "/reminders?view=fired" },
          { value: "all", label: "all", count: counts.all, href: "/reminders?view=all" },
        ]}
      />

      <DataTable columns={COLUMNS} rowCount={visible.length} empty="No reminders found.">
        {visible.map((r) => {
          const status = r.fired ? "fired" : new Date(r.fireAt) < now ? "expired" : "pending";
          return (
            <DataRow key={r.id}>
              <TableCell className="max-w-xs truncate text-sm text-foreground/80">
                {r.message}
              </TableCell>
              <TableCell className="text-xs tabular-nums text-muted-foreground">
                {new Date(r.fireAt).toLocaleString()}
              </TableCell>
              <TableCell>
                <span
                  className={`inline-flex items-center gap-1.5 text-xs ${
                    status === "pending"
                      ? "text-primary/70"
                      : status === "fired"
                        ? "text-faint"
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
              <TableCell className="font-mono text-xs text-faint">{r.chatId}</TableCell>
              <TableCell className="text-xs tabular-nums text-faint">
                {new Date(r.createdAt).toLocaleDateString()}
              </TableCell>
            </DataRow>
          );
        })}
      </DataTable>
    </div>
  );
}
