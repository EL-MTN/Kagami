"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import cronstrue from "cronstrue";
import { Download, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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

function statusVariant(status: string) {
  switch (status) {
    case "completed":
      return "default" as const;
    case "failed":
      return "destructive" as const;
    case "running":
      return "secondary" as const;
    default:
      return "secondary" as const;
  }
}

function getCronLabel(expr: string | null): string {
  if (!expr) return "on-demand";
  try {
    return cronstrue.toString(expr, {
      use24HourTimeFormat: false,
      verbose: true,
    });
  } catch {
    return expr;
  }
}

interface SkillTableProps {
  initialSkills: SkillListItem[];
}

export function SkillTable({ initialSkills }: SkillTableProps) {
  const router = useRouter();
  const [skills, setSkills] = useState(initialSkills);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const defaultChatId = skills[0]?.chatId ?? "";

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    // Optimistic update
    setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, enabled } : s)));

    try {
      const res = await fetch(`/api/skills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });

      if (!res.ok) {
        // Revert on failure
        setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !enabled } : s)));
      }
    } catch {
      setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !enabled } : s)));
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
      {/* Actions bar */}
      <div className="flex items-center gap-2">
        <SkillCreateDialog defaultChatId={defaultChatId} onCreated={handleCreated} />
        <SkillImportDialog onImported={handleImported} />
        <Button variant="outline" size="sm" asChild>
          <a href="/api/skills/export" download>
            <Download className="h-4 w-4" />
            Export
          </a>
        </Button>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Report</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead>Last Run</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {skills.map((s) => (
              <TableRow key={s.id}>
                <TableCell>
                  <Link
                    href={`/skills/${s.id}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {s.name}
                  </Link>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                  {s.description}
                </TableCell>
                <TableCell className="text-sm" title={s.cronSchedule ?? undefined}>
                  {getCronLabel(s.cronSchedule)}
                </TableCell>
                <TableCell>
                  <Badge variant={s.reportMode === "alert" ? "secondary" : "default"}>
                    {s.reportMode}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Switch
                    checked={s.enabled}
                    onCheckedChange={(checked) => void handleToggle(s.id, !!checked)}
                  />
                </TableCell>
                <TableCell className="text-sm">
                  {s.lastRun ? (
                    <Badge variant={statusVariant(s.lastRun.status)}>{s.lastRun.status}</Badge>
                  ) : (
                    <span className="text-muted-foreground">never</span>
                  )}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleteTarget({ id: s.id, name: s.name })}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {skills.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  No skills found. Create one or import from a JSON file.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Delete dialog */}
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
