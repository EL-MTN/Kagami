"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ParameterEditor } from "./parameter-editor";
import { SkillRunButton } from "./skill-run-button";
import { describeCron } from "@/lib/cron-format";
import type { SkillListItem, SkillParameter } from "@/lib/skill-schema";

interface ApiErrorResponse {
  error?: string;
  issues?: { path?: string[]; message: string }[];
}

interface ApiSkillResponse extends ApiErrorResponse {
  skill?: SkillListItem;
}

interface SkillEditorProps {
  skill: SkillListItem;
}

interface Draft {
  name: string;
  description: string;
  prompt: string;
  parameters: SkillParameter[];
  cronSchedule: string;
  reportMode: "always" | "alert";
  enabled: boolean;
}

function skillToDraft(skill: SkillListItem): Draft {
  return {
    name: skill.name,
    description: skill.description,
    prompt: skill.prompt,
    parameters: skill.parameters,
    cronSchedule: skill.cronSchedule ?? "",
    reportMode: skill.reportMode,
    enabled: skill.enabled,
  };
}

function isDirty(draft: Draft, saved: Draft): boolean {
  return JSON.stringify(draft) !== JSON.stringify(saved);
}

export function SkillEditor({ skill }: SkillEditorProps) {
  const [saved, setSaved] = useState<Draft>(() => skillToDraft(skill));
  const [draft, setDraft] = useState<Draft>(() => skillToDraft(skill));
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
    if (draft.enabled !== saved.enabled) body.enabled = draft.enabled;
    if (JSON.stringify(draft.parameters) !== JSON.stringify(saved.parameters))
      body.parameters = draft.parameters;
    if (draft.cronSchedule !== saved.cronSchedule) body.cronSchedule = draft.cronSchedule || null;

    try {
      const res = await fetch(`/api/skills/${skill.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = (await res.json()) as ApiSkillResponse;

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

      const newSaved = skillToDraft(data.skill!);
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
          <SkillRunButton
            skillId={skill.id}
            disabled={dirty || !draft.enabled}
            disabledReason={
              dirty
                ? "Save your changes before running"
                : !draft.enabled
                  ? "Enable the skill to run it"
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
            htmlFor="skill-name"
            className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
          >
            Name
          </Label>
          <Input
            id="skill-name"
            value={draft.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="skill-name"
            className="font-mono"
          />
          {errors.name && <p className="text-xs text-destructive-foreground">{errors.name}</p>}
        </div>
        <div className="space-y-2">
          <Label
            htmlFor="skill-description"
            className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
          >
            Description
          </Label>
          <Input
            id="skill-description"
            value={draft.description}
            onChange={(e) => update({ description: e.target.value })}
            placeholder="What this skill does"
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
            htmlFor="skill-prompt"
            className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
          >
            Prompt
          </Label>
          <span className="text-[10px] tabular-nums text-muted-foreground/40">
            {draft.prompt.length} chars
          </span>
        </div>
        <Textarea
          id="skill-prompt"
          value={draft.prompt}
          onChange={(e) => update({ prompt: e.target.value })}
          placeholder="Execution instructions for the skill..."
          className="min-h-[200px] font-mono text-xs leading-relaxed"
          style={{ fieldSizing: "content" } as React.CSSProperties}
        />
        {errors.prompt && <p className="text-xs text-destructive-foreground">{errors.prompt}</p>}
      </div>

      {/* Cron + Report Mode */}
      <div className="grid grid-cols-2 gap-6">
        <div className="space-y-2">
          <Label
            htmlFor="skill-cron"
            className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
          >
            Schedule
          </Label>
          <Input
            id="skill-cron"
            value={draft.cronSchedule}
            onChange={(e) => update({ cronSchedule: e.target.value })}
            placeholder="e.g. 0 9 * * * (leave empty for on-demand)"
            className="font-mono"
          />
          {draft.cronSchedule && (
            <p
              className={`text-[11px] ${cronDesc ? "text-muted-foreground/60" : "text-destructive-foreground"}`}
            >
              {cronDesc ?? "Invalid cron expression"}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label
            htmlFor="skill-report-mode"
            className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
          >
            Report Mode
          </Label>
          <Select
            id="skill-report-mode"
            value={draft.reportMode}
            onChange={(e) => update({ reportMode: e.target.value as "always" | "alert" })}
          >
            <option value="always">Always — report every run</option>
            <option value="alert">Alert — only noteworthy events</option>
          </Select>
        </div>
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
      <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border pt-6 text-[10px] uppercase tracking-[0.15em] text-muted-foreground/30">
        <span>v{skill.version}</span>
        <span>Chat: {skill.chatId}</span>
        <span>Created: {new Date(skill.createdAt).toLocaleDateString()}</span>
        <span>Updated: {new Date(skill.updatedAt).toLocaleDateString()}</span>
        {skill.nextRunAt && <span>Next: {new Date(skill.nextRunAt).toLocaleString()}</span>}
      </div>
    </div>
  );
}
