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
import { SkillCreateDialog } from "./skill-create-dialog";
import { SkillImportDialog } from "./skill-import-dialog";
import { SkillDeleteDialog } from "./skill-delete-dialog";
import type { SkillListItem } from "@/lib/skill-schema";

interface SkillTableProps {
  initialSkills: SkillListItem[];
}

type FilterMode = "all" | "enabled" | "cron";

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
      return (
        s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
      );
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
      <div className="flex flex-wrap items-center gap-2">
        <SkillCreateDialog knownChatIds={knownChatIds} onCreated={handleCreated} />
        <SkillImportDialog onImported={handleImported} />
        <Button variant="ghost" size="sm" asChild className="text-muted-foreground">
          <a href="/api/skills/export" download>
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
              placeholder="Search skills"
              className="h-8 w-56 pl-7 text-xs"
            />
          </div>
          <div className="flex overflow-hidden rounded-md border border-border text-xs">
            {(["all", "enabled", "cron"] as const).map((mode) => (
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
                Report
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
            {visibleSkills.map((s) => (
              <TableRow
                key={s.id}
                className="border-border/50 transition-colors hover:bg-primary/[0.02]"
              >
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
                  className="text-xs text-muted-foreground/60"
                  title={s.cronSchedule ?? undefined}
                >
                  {cronLabel(s.cronSchedule)}
                </TableCell>
                <TableCell>
                  <span
                    className={`text-xs ${s.reportMode === "alert" ? "text-primary/60" : "text-muted-foreground/60"}`}
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
                    <span className="text-xs text-muted-foreground/30">never</span>
                  )}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground/30 hover:text-destructive-foreground"
                    onClick={() => setDeleteTarget({ id: s.id, name: s.name })}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {visibleSkills.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-12 text-center text-sm text-muted-foreground/60"
                >
                  {skills.length === 0
                    ? "No skills found. Create one or import from a JSON file."
                    : "No skills match the current filter."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

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
