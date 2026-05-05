"use client";

import { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, Trash2 } from "lucide-react";
import { cronLabel } from "@/lib/cron-format";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TableCell } from "@/components/ui/table";
import {
  DataRow,
  DataTable,
  DataToolbar,
  FilterPills,
  SearchInput,
  type DataTableColumn,
} from "@/components/shell";
import { WatcherCreateDialog } from "./watcher-create-dialog";
import { WatcherImportDialog } from "./watcher-import-dialog";
import { WatcherDeleteDialog } from "./watcher-delete-dialog";
import type { WatcherListItem } from "@/lib/watcher-schema";

interface WatcherTableProps {
  initialWatchers: WatcherListItem[];
}

type FilterMode = "all" | "enabled" | "snoozed";

const COLUMNS: DataTableColumn[] = [
  { key: "name", label: "Name" },
  { key: "description", label: "Description" },
  { key: "schedule", label: "Schedule" },
  { key: "fires", label: "Fires" },
  { key: "enabled", label: "Enabled" },
  { key: "lastRun", label: "Last Run" },
  { key: "actions", label: "", className: "w-10" },
];

export function WatcherTable({ initialWatchers }: WatcherTableProps) {
  const router = useRouter();
  const [watchers, setWatchers] = useState(initialWatchers);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [toggleError, setToggleError] = useState<string | null>(null);

  const knownChatIds = useMemo(
    () => Array.from(new Set(watchers.map((w) => w.chatId))).sort(),
    [watchers],
  );

  const visibleWatchers = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    return watchers.filter((w) => {
      if (filter === "enabled" && !w.enabled) return false;
      if (filter === "snoozed") {
        const snoozed = w.snoozedUntil && new Date(w.snoozedUntil).getTime() > now;
        if (!snoozed) return false;
      }
      if (!q) return true;
      return w.name.toLowerCase().includes(q) || w.description.toLowerCase().includes(q);
    });
  }, [watchers, query, filter]);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    setToggleError(null);
    setWatchers((prev) => prev.map((w) => (w.id === id ? { ...w, enabled } : w)));
    try {
      const res = await fetch(`/api/watchers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setWatchers((prev) => prev.map((w) => (w.id === id ? { ...w, enabled: !enabled } : w)));
        setToggleError(data.error ?? "Failed to update");
        window.setTimeout(() => setToggleError(null), 4000);
      }
    } catch {
      setWatchers((prev) => prev.map((w) => (w.id === id ? { ...w, enabled: !enabled } : w)));
      setToggleError("Network error");
      window.setTimeout(() => setToggleError(null), 4000);
    }
  }, []);

  function handleCreated(watcher: WatcherListItem) {
    setWatchers((prev) => [watcher, ...prev]);
  }

  function handleDeleted(id: string) {
    setWatchers((prev) => prev.filter((w) => w.id !== id));
    setDeleteTarget(null);
  }

  function handleImported() {
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <DataToolbar
        actions={
          <>
            <WatcherCreateDialog knownChatIds={knownChatIds} onCreated={handleCreated} />
            <WatcherImportDialog onImported={handleImported} />
            <Button variant="ghost" size="sm" asChild className="text-muted-foreground">
              <a href="/api/watchers/export" download>
                <Download className="h-3.5 w-3.5" />
                Export
              </a>
            </Button>
          </>
        }
        filters={
          <>
            {toggleError && (
              <span className="text-xs text-destructive-foreground" role="alert">
                {toggleError}
              </span>
            )}
            <SearchInput value={query} onChange={setQuery} placeholder="Search watchers" />
            <FilterPills<FilterMode>
              options={[
                { value: "all", label: "all" },
                { value: "enabled", label: "enabled" },
                { value: "snoozed", label: "snoozed" },
              ]}
              value={filter}
              onChange={setFilter}
            />
          </>
        }
      />

      <DataTable
        columns={COLUMNS}
        rowCount={visibleWatchers.length}
        empty={
          watchers.length === 0
            ? "No watchers found. Create one or import from a JSON file."
            : "No watchers match the current filter."
        }
      >
        {visibleWatchers.map((w) => {
          const snoozed = w.snoozedUntil && new Date(w.snoozedUntil).getTime() > Date.now();
          return (
            <DataRow key={w.id}>
              <TableCell>
                <Link
                  href={`/watchers/${w.id}`}
                  className="text-sm font-medium text-foreground/90 transition-colors hover:text-primary"
                >
                  {w.name}
                </Link>
                {snoozed && (
                  <span className="ml-2 rounded-full bg-muted-foreground/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                    snoozed
                  </span>
                )}
                {w.archivedAt && (
                  <span className="ml-2 rounded-full bg-muted-foreground/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                    archived
                  </span>
                )}
              </TableCell>
              <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                {w.description}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground" title={w.cronSchedule}>
                {cronLabel(w.cronSchedule)}
              </TableCell>
              <TableCell className="text-xs tabular-nums text-muted-foreground">
                {w.fireCount}
                {w.maxFires != null ? `/${w.maxFires}` : ""}
                {w.oneShot && " · 1×"}
              </TableCell>
              <TableCell>
                <Switch
                  checked={w.enabled}
                  onCheckedChange={(checked) => void handleToggle(w.id, !!checked)}
                />
              </TableCell>
              <TableCell>
                {w.lastRun ? (
                  <span
                    className={`inline-flex items-center gap-1.5 text-xs ${
                      w.lastRun.status === "completed"
                        ? w.lastRun.triggered && !w.lastRun.suppressed
                          ? "text-primary"
                          : "text-primary/60"
                        : w.lastRun.status === "failed"
                          ? "text-destructive-foreground"
                          : "text-muted-foreground"
                    }`}
                    title={
                      w.lastRun.suppressed ? "matched but silenced (cooldown/snooze)" : undefined
                    }
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        w.lastRun.status === "completed"
                          ? w.lastRun.triggered && !w.lastRun.suppressed
                            ? "bg-primary"
                            : "bg-primary/40"
                          : w.lastRun.status === "failed"
                            ? "bg-destructive/60"
                            : "bg-muted-foreground/50 animate-pulse"
                      }`}
                    />
                    {w.lastRun.suppressed
                      ? "silenced"
                      : w.lastRun.triggered
                        ? "triggered"
                        : w.lastRun.status}
                  </span>
                ) : (
                  <span className="text-xs text-faint">never</span>
                )}
              </TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-faint hover:text-destructive-foreground"
                  onClick={() => setDeleteTarget({ id: w.id, name: w.name })}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </TableCell>
            </DataRow>
          );
        })}
      </DataTable>

      {deleteTarget && (
        <WatcherDeleteDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          watcherId={deleteTarget.id}
          watcherName={deleteTarget.name}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  );
}
