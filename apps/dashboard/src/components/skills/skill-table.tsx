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
import { SkillCreateDialog } from "./skill-create-dialog";
import { SkillImportDialog } from "./skill-import-dialog";
import { SkillDeleteDialog } from "./skill-delete-dialog";
import type { SkillListItem } from "@/lib/skill-schema";

interface SkillTableProps {
  initialSkills: SkillListItem[];
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

export function SkillTable({ initialSkills }: SkillTableProps) {
  const router = useRouter();
  const [skills, setSkills] = useState(initialSkills);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [toggleError, setToggleError] = useState<string | null>(null);

  const knownChatIds = useMemo(
    () => Array.from(new Set(skills.map((s) => s.chatId))).sort(),
    [skills],
  );

  const visibleSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => {
      if (filter === "enabled" && !s.enabled) return false;
      if (filter === "cron" && !s.cronSchedule) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
    });
  }, [skills, query, filter]);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    setToggleError(null);
    setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, enabled } : s)));
    try {
      const res = await fetch(`/api/skills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !enabled } : s)));
        setToggleError(data.error ?? "Failed to update");
        window.setTimeout(() => setToggleError(null), 4000);
      }
    } catch {
      setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !enabled } : s)));
      setToggleError("Network error");
      window.setTimeout(() => setToggleError(null), 4000);
    }
  }, []);

  function handleCreated(skill: SkillListItem) {
    setSkills((prev) => [skill, ...prev]);
  }

  function handleDeleted(id: string) {
    setSkills((prev) => prev.filter((s) => s.id !== id));
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
            <SkillCreateDialog knownChatIds={knownChatIds} onCreated={handleCreated} />
            <SkillImportDialog onImported={handleImported} />
            <Button variant="ghost" size="sm" asChild className="text-muted-foreground">
              <a href="/api/skills/export" download>
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
            <SearchInput value={query} onChange={setQuery} placeholder="Search skills" />
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
        rowCount={visibleSkills.length}
        empty={
          skills.length === 0
            ? "No skills found. Create one or import from a JSON file."
            : "No skills match the current filter."
        }
      >
        {visibleSkills.map((s) => (
          <DataRow key={s.id}>
            <TableCell>
              <Link
                href={`/skills/${s.id}`}
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
        <SkillDeleteDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          skillId={deleteTarget.id}
          skillName={deleteTarget.name}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  );
}
