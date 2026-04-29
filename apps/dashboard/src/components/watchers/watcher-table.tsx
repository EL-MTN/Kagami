"use client";

import { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, Trash2, Search } from "lucide-react";
import { cronLabel } from "@/lib/cron-format";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { WatcherCreateDialog } from "./watcher-create-dialog";
import { WatcherImportDialog } from "./watcher-import-dialog";
import { WatcherDeleteDialog } from "./watcher-delete-dialog";
import type { WatcherListItem } from "@/lib/watcher-schema";

interface WatcherTableProps {
  initialWatchers: WatcherListItem[];
}

type FilterMode = "all" | "enabled" | "snoozed";

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
      <div className="flex flex-wrap items-center gap-2">
        <WatcherCreateDialog knownChatIds={knownChatIds} onCreated={handleCreated} />
        <WatcherImportDialog onImported={handleImported} />
        <Button variant="ghost" size="sm" asChild className="text-muted-foreground">
          <a href="/api/watchers/export" download>
            <Download className="h-3.5 w-3.5" />
            Export
          </a>
        </Button>

        <div className="ml-auto flex items-center gap-2">
          {toggleError && (
            <span className="text-xs text-destructive-foreground" role="alert">
              {toggleError}
            </span>
          )}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search watchers"
              className="h-8 w-56 pl-7 text-xs"
            />
          </div>
          <div className="flex overflow-hidden rounded-md border border-border text-xs">
            {(["all", "enabled", "snoozed"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setFilter(mode)}
                className={`px-2.5 py-1 transition-colors ${
                  filter === mode
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground/70 hover:text-foreground"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-border hover:bg-transparent">
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Name
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Description
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Schedule
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Fires
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Enabled
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Last Run
              </TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleWatchers.map((w) => {
              const snoozed = w.snoozedUntil && new Date(w.snoozedUntil).getTime() > Date.now();
              return (
                <TableRow
                  key={w.id}
                  className="border-border/50 transition-colors hover:bg-primary/[0.02]"
                >
                  <TableCell>
                    <Link
                      href={`/watchers/${w.id}`}
                      className="text-sm font-medium text-foreground/90 transition-colors hover:text-primary"
                    >
                      {w.name}
                    </Link>
                    {snoozed && (
                      <span className="ml-2 rounded-full bg-muted-foreground/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground/70">
                        snoozed
                      </span>
                    )}
                    {w.archivedAt && (
                      <span className="ml-2 rounded-full bg-muted-foreground/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground/70">
                        archived
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                    {w.description}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground/60" title={w.cronSchedule}>
                    {cronLabel(w.cronSchedule)}
                  </TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground/60">
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
                          w.lastRun.suppressed
                            ? "matched but silenced (cooldown/snooze)"
                            : undefined
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
                      <span className="text-xs text-muted-foreground/30">never</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground/30 hover:text-destructive-foreground"
                      onClick={() => setDeleteTarget({ id: w.id, name: w.name })}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {visibleWatchers.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-12 text-center text-sm text-muted-foreground/60"
                >
                  {watchers.length === 0
                    ? "No watchers found. Create one or import from a JSON file."
                    : "No watchers match the current filter."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

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
