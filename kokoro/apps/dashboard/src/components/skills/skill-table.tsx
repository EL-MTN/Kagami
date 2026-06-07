"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Trash2 } from "lucide-react";
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
import { SkillDeleteDialog } from "./skill-delete-dialog";
import type { SkillListItem } from "@/lib/skill-schema";

interface SkillTableProps {
  initialSkills: SkillListItem[];
}

type FilterMode = "all" | "enabled" | "manual" | "distilled";

const COLUMNS: DataTableColumn[] = [
  { key: "name", label: "Name" },
  { key: "description", label: "Description" },
  { key: "triggers", label: "Triggers" },
  { key: "tags", label: "Tags" },
  { key: "source", label: "Source" },
  { key: "usage", label: "Uses" },
  { key: "enabled", label: "Enabled" },
  { key: "actions", label: "", className: "w-10" },
];

function pillList(values: string[], empty = "none") {
  if (values.length === 0) return <span className="text-xs text-faint">{empty}</span>;
  return (
    <div className="flex max-w-xs flex-wrap gap-1">
      {values.slice(0, 3).map((value) => (
        <span
          key={value}
          className="rounded-md border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground"
        >
          {value}
        </span>
      ))}
      {values.length > 3 && <span className="text-[10px] text-faint">+{values.length - 3}</span>}
    </div>
  );
}

export function SkillTable({ initialSkills }: SkillTableProps) {
  const [skills, setSkills] = useState(initialSkills);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [toggleError, setToggleError] = useState<string | null>(null);

  const knownChatIds = useMemo(
    () => Array.from(new Set(skills.map((skill) => skill.chatId))).sort(),
    [skills],
  );

  const visibleSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((skill) => {
      if (filter === "enabled" && !skill.enabled) return false;
      if (filter === "manual" && skill.source !== "manual") return false;
      if (filter === "distilled" && skill.source !== "distilled") return false;
      if (!q) return true;
      const haystack = [skill.name, skill.description, skill.body, ...skill.triggers, ...skill.tags]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [skills, query, filter]);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    setToggleError(null);
    setSkills((prev) => prev.map((skill) => (skill.id === id ? { ...skill, enabled } : skill)));
    try {
      const res = await fetch(`/api/skills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setSkills((prev) =>
          prev.map((skill) => (skill.id === id ? { ...skill, enabled: !enabled } : skill)),
        );
        setToggleError(data.error ?? "Failed to update");
        window.setTimeout(() => setToggleError(null), 4000);
      }
    } catch {
      setSkills((prev) =>
        prev.map((skill) => (skill.id === id ? { ...skill, enabled: !enabled } : skill)),
      );
      setToggleError("Network error");
      window.setTimeout(() => setToggleError(null), 4000);
    }
  }, []);

  function handleCreated(skill: SkillListItem) {
    setSkills((prev) => [skill, ...prev]);
  }

  function handleDeleted(id: string) {
    setSkills((prev) => prev.filter((skill) => skill.id !== id));
    setDeleteTarget(null);
  }

  return (
    <div className="space-y-4">
      <DataToolbar
        actions={<SkillCreateDialog knownChatIds={knownChatIds} onCreated={handleCreated} />}
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
                { value: "manual", label: "manual" },
                { value: "distilled", label: "distilled" },
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
            ? "No skills found. Create one or approve a proposed skill from chat."
            : "No skills match the current filter."
        }
      >
        {visibleSkills.map((skill) => (
          <DataRow key={skill.id}>
            <TableCell>
              <Link
                href={`/skills/${skill.id}`}
                className="text-sm font-medium text-foreground/90 transition-colors hover:text-primary"
              >
                {skill.name}
              </Link>
            </TableCell>
            <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
              {skill.description}
            </TableCell>
            <TableCell>{pillList(skill.triggers)}</TableCell>
            <TableCell>{pillList(skill.tags)}</TableCell>
            <TableCell>
              <span className="text-xs text-muted-foreground">{skill.source}</span>
            </TableCell>
            <TableCell>
              <span className="text-xs tabular-nums text-muted-foreground">{skill.usageCount}</span>
            </TableCell>
            <TableCell>
              <Switch
                checked={skill.enabled}
                onCheckedChange={(checked) => void handleToggle(skill.id, !!checked)}
              />
            </TableCell>
            <TableCell>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-faint hover:text-destructive-foreground"
                onClick={() => setDeleteTarget({ id: skill.id, name: skill.name })}
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
