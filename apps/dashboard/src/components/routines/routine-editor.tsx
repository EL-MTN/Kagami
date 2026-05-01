"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ParameterEditor } from "./parameter-editor";
import { RoutineRunButton } from "./routine-run-button";
import { describeCron } from "@/lib/cron-format";
import type { RoutineListItem, RoutineParameter } from "@/lib/routine-schema";

interface ApiErrorResponse {
  error?: string;
  issues?: { path?: string[]; message: string }[];
}

interface ApiRoutineResponse extends ApiErrorResponse {
  routine?: RoutineListItem;
}

interface RoutineEditorProps {
  routine: RoutineListItem;
}

interface Draft {
  name: string;
  description: string;
  prompt: string;
  parameters: RoutineParameter[];
  cronSchedule: string;
  reportMode: "always" | "alert";
  purity: "read" | "action";
  enabled: boolean;
}

function routineToDraft(routine: RoutineListItem): Draft {
  return {
    name: routine.name,
    description: routine.description,
    prompt: routine.prompt,
    parameters: routine.parameters,
    cronSchedule: routine.cronSchedule ?? "",
    reportMode: routine.reportMode,
    purity: routine.purity,
    enabled: routine.enabled,
  };
}

function isDirty(draft: Draft, saved: Draft): boolean {
  return JSON.stringify(draft) !== JSON.stringify(saved);
}

export function RoutineEditor({ routine }: RoutineEditorProps) {
  const [saved, setSaved] = useState<Draft>(() => routineToDraft(routine));
  const [draft, setDraft] = useState<Draft>(() => routineToDraft(routine));
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<string | null>(null);

  const dirty = isDirty(draft, saved);
  const cronDesc = describeCron(draft.cronSchedule);
  const saveRef = useRef<() => void>(() => {});

  const update = useCallback((patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    const keys = Object.keys(patch);
    setErrors((e) => {
      const next = { ...e };
      for (const k of keys) delete next[k];
      return next;
    });
  }, []);

  // Warn before navigating away with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // Cmd/Ctrl+S triggers save when dirty.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  async function handleSave() {
    setSaving(true);
    setErrors({});

    const body: Record<string, unknown> = {};
    if (draft.name !== saved.name) body.name = draft.name;
    if (draft.description !== saved.description) body.description = draft.description;
    if (draft.prompt !== saved.prompt) body.prompt = draft.prompt;
    if (draft.reportMode !== saved.reportMode) body.reportMode = draft.reportMode;
    if (draft.purity !== saved.purity) body.purity = draft.purity;
    if (draft.enabled !== saved.enabled) body.enabled = draft.enabled;
    if (JSON.stringify(draft.parameters) !== JSON.stringify(saved.parameters))
      body.parameters = draft.parameters;
    if (draft.cronSchedule !== saved.cronSchedule) body.cronSchedule = draft.cronSchedule || null;

    try {
      const res = await fetch(`/api/routines/${routine.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = (await res.json()) as ApiRoutineResponse;

      if (!res.ok) {
        if (data.issues) {
          const fieldErrors: Record<string, string> = {};
          for (const issue of data.issues) {
            const path = issue.path?.join(".") ?? "general";
            fieldErrors[path] = issue.message;
          }
          setErrors(fieldErrors);
        } else {
          setErrors({ general: data.error ?? "Save failed" });
        }
        return;
      }

      const newSaved = routineToDraft(data.routine!);
      setSaved(newSaved);
      setDraft(newSaved);
      setFlash("Saved");
      setTimeout(() => setFlash(null), 2000);
    } catch {
      setErrors({ general: "Network error" });
    } finally {
      setSaving(false);
    }
  }

  saveRef.current = () => {
    if (dirty && !saving) void handleSave();
  };

  return (
    <div className="space-y-8">
      {/* Save bar */}
      <div className="flex items-center gap-3">
        {dirty && <span className="text-xs font-medium text-primary">Unsaved changes</span>}
        {flash && <span className="text-xs font-medium text-primary/60">{flash}</span>}
        {errors.general && (
          <span className="text-xs text-destructive-foreground">{errors.general}</span>
        )}
        <div className="ml-auto flex items-center gap-4">
          <RoutineRunButton
            routineId={routine.id}
            disabled={dirty || !draft.enabled}
            disabledReason={
              dirty
                ? "Save your changes before running"
                : !draft.enabled
                  ? "Enable the routine to run it"
                  : undefined
            }
          />
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Enabled</Label>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(checked) => update({ enabled: !!checked })}
            />
          </div>
          <Button onClick={() => void handleSave()} disabled={!dirty || saving} size="sm">
            {saving ? "Saving..." : "Save (⌘S)"}
          </Button>
        </div>
      </div>

      {/* Name + Description */}
      <div className="grid grid-cols-2 gap-6">
        <div className="space-y-2">
          <Label
            htmlFor="routine-name"
            className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
          >
            Name
          </Label>
          <Input
            id="routine-name"
            value={draft.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="routine-name"
            className="font-mono"
          />
          {errors.name && <p className="text-xs text-destructive-foreground">{errors.name}</p>}
        </div>
        <div className="space-y-2">
          <Label
            htmlFor="routine-description"
            className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
          >
            Description
          </Label>
          <Input
            id="routine-description"
            value={draft.description}
            onChange={(e) => update({ description: e.target.value })}
            placeholder="What this routine does"
          />
          {errors.description && (
            <p className="text-xs text-destructive-foreground">{errors.description}</p>
          )}
        </div>
      </div>

      {/* Prompt */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label
            htmlFor="routine-prompt"
            className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
          >
            Prompt
          </Label>
          <span className="text-[10px] tabular-nums text-faint">{draft.prompt.length} chars</span>
        </div>
        <Textarea
          id="routine-prompt"
          value={draft.prompt}
          onChange={(e) => update({ prompt: e.target.value })}
          placeholder="Execution instructions for the routine..."
          className="min-h-[200px] font-mono text-xs leading-relaxed"
          style={{ fieldSizing: "content" }}
        />
        {errors.prompt && <p className="text-xs text-destructive-foreground">{errors.prompt}</p>}
      </div>

      {/* Cron + Report Mode */}
      <div className="grid grid-cols-2 gap-6">
        <div className="space-y-2">
          <Label
            htmlFor="routine-cron"
            className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
          >
            Schedule
          </Label>
          <Input
            id="routine-cron"
            value={draft.cronSchedule}
            onChange={(e) => update({ cronSchedule: e.target.value })}
            placeholder="e.g. 0 9 * * * (leave empty for on-demand)"
            className="font-mono"
          />
          {draft.cronSchedule && (
            <p
              className={`text-[11px] ${cronDesc ? "text-muted-foreground" : "text-destructive-foreground"}`}
            >
              {cronDesc ?? "Invalid cron expression"}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label
            htmlFor="routine-report-mode"
            className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
          >
            Report Mode
          </Label>
          <Select
            id="routine-report-mode"
            value={draft.reportMode}
            onChange={(e) => update({ reportMode: e.target.value as "always" | "alert" })}
          >
            <option value="always">Always — report every run</option>
            <option value="alert">Alert — only noteworthy events</option>
          </Select>
        </div>
      </div>

      {/* Purity */}
      <div className="space-y-2">
        <Label
          htmlFor="routine-purity"
          className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
        >
          Purity
        </Label>
        <Select
          id="routine-purity"
          value={draft.purity}
          onChange={(e) => update({ purity: e.target.value as "read" | "action" })}
        >
          <option value="action">Action — sends, writes, modifies (watchers cannot invoke)</option>
          <option value="read">
            Read — observes only (search, summarize, query). Safe for watchers.
          </option>
        </Select>
        <p className="text-[11px] text-faint">
          Watchers can only compose with read-purity routines via useRoutine. Action is the
          conservative default.
        </p>
      </div>

      {/* Parameters */}
      <ParameterEditor
        parameters={draft.parameters}
        onChange={(parameters) => update({ parameters })}
      />
      {errors.parameters && (
        <p className="text-xs text-destructive-foreground">{errors.parameters}</p>
      )}

      {/* Metadata footer */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border pt-6 text-[10px] uppercase tracking-[0.15em] text-faint">
        <span>v{routine.version}</span>
        <span>Chat: {routine.chatId}</span>
        <span>Created: {new Date(routine.createdAt).toLocaleDateString()}</span>
        <span>Updated: {new Date(routine.updatedAt).toLocaleDateString()}</span>
        {routine.nextRunAt && <span>Next: {new Date(routine.nextRunAt).toLocaleString()}</span>}
      </div>
    </div>
  );
}
