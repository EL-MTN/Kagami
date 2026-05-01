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
import { RoutineCreateDialog } from "./routine-create-dialog";
import { RoutineImportDialog } from "./routine-import-dialog";
import { RoutineDeleteDialog } from "./routine-delete-dialog";
import type { RoutineListItem } from "@/lib/routine-schema";

interface RoutineTableProps {
  initialRoutines: RoutineListItem[];
}

type FilterMode = "all" | "enabled" | "cron";

const COLUMNS: DataTableColumn[] = [
  { key: "name", label: "Name" },
  { key: "description", label: "Description" },
  { key: "schedule", label: "Schedule" },
  { key: "report", label: "Report" },
  { key: "enabled", label: "Enabled" },
  { key: "lastRun", label: "Last Run" },
  { key: "actions", label: "", className: "w-10" },
];

export function RoutineTable({ initialRoutines }: RoutineTableProps) {
  const router = useRouter();
  const [routines, setRoutines] = useState(initialRoutines);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [toggleError, setToggleError] = useState<string | null>(null);

  const knownChatIds = useMemo(
    () => Array.from(new Set(routines.map((s) => s.chatId))).sort(),
    [routines],
  );

  const visibleRoutines = useMemo(() => {
    const q = query.trim().toLowerCase();
    return routines.filter((s) => {
      if (filter === "enabled" && !s.enabled) return false;
      if (filter === "cron" && !s.cronSchedule) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
    });
  }, [routines, query, filter]);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    setToggleError(null);
    setRoutines((prev) => prev.map((s) => (s.id === id ? { ...s, enabled } : s)));
    try {
      const res = await fetch(`/api/routines/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setRoutines((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !enabled } : s)));
        setToggleError(data.error ?? "Failed to update");
        window.setTimeout(() => setToggleError(null), 4000);
      }
    } catch {
      setRoutines((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !enabled } : s)));
      setToggleError("Network error");
      window.setTimeout(() => setToggleError(null), 4000);
    }
  }, []);

  function handleCreated(routine: RoutineListItem) {
    setRoutines((prev) => [routine, ...prev]);
  }

  function handleDeleted(id: string) {
    setRoutines((prev) => prev.filter((s) => s.id !== id));
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
            <RoutineCreateDialog knownChatIds={knownChatIds} onCreated={handleCreated} />
            <RoutineImportDialog onImported={handleImported} />
            <Button variant="ghost" size="sm" asChild className="text-muted-foreground">
              <a href="/api/routines/export" download>
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
            <SearchInput value={query} onChange={setQuery} placeholder="Search routines" />
            <FilterPills<FilterMode>
              options={[
                { value: "all", label: "all" },
                { value: "enabled", label: "enabled" },
                { value: "cron", label: "cron" },
              ]}
              value={filter}
              onChange={setFilter}
            />
          </>
        }
      />

      <DataTable
        columns={COLUMNS}
        rowCount={visibleRoutines.length}
        empty={
          routines.length === 0
            ? "No routines found. Create one or import from a JSON file."
            : "No routines match the current filter."
        }
      >
        {visibleRoutines.map((s) => (
          <DataRow key={s.id}>
            <TableCell>
              <Link
                href={`/routines/${s.id}`}
                className="text-sm font-medium text-foreground/90 transition-colors hover:text-primary"
              >
                {s.name}
              </Link>
            </TableCell>
            <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
              {s.description}
            </TableCell>
            <TableCell
              className="text-xs text-muted-foreground"
              title={s.cronSchedule ?? undefined}
            >
              {cronLabel(s.cronSchedule)}
            </TableCell>
            <TableCell>
              <span
                className={`text-xs ${s.reportMode === "alert" ? "text-primary/60" : "text-muted-foreground"}`}
              >
                {s.reportMode}
              </span>
            </TableCell>
            <TableCell>
              <Switch
                checked={s.enabled}
                onCheckedChange={(checked) => void handleToggle(s.id, !!checked)}
              />
            </TableCell>
            <TableCell>
              {s.lastRun ? (
                <span
                  className={`inline-flex items-center gap-1.5 text-xs ${
                    s.lastRun.status === "completed"
                      ? "text-primary/60"
                      : s.lastRun.status === "failed"
                        ? "text-destructive-foreground"
                        : "text-muted-foreground"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      s.lastRun.status === "completed"
                        ? "bg-primary/60"
                        : s.lastRun.status === "failed"
                          ? "bg-destructive/60"
                          : "bg-muted-foreground/50 animate-pulse"
                    }`}
                  />
                  {s.lastRun.status}
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
                onClick={() => setDeleteTarget({ id: s.id, name: s.name })}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </TableCell>
          </DataRow>
        ))}
      </DataTable>

      {deleteTarget && (
        <RoutineDeleteDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          routineId={deleteTarget.id}
          routineName={deleteTarget.name}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  );
}
