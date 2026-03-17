"use client";

import { useState, useCallback } from "react";
import cronstrue from "cronstrue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ParameterEditor } from "./parameter-editor";
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

function getCronDescription(expr: string): string | null {
  if (!expr) return null;
  try {
    return cronstrue.toString(expr, {
      use24HourTimeFormat: false,
      verbose: true,
    });
  } catch {
    return null;
  }
}

export function SkillEditor({ skill }: SkillEditorProps) {
  const [saved, setSaved] = useState<Draft>(() => skillToDraft(skill));
  const [draft, setDraft] = useState<Draft>(() => skillToDraft(skill));
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<string | null>(null);

  const dirty = isDirty(draft, saved);
  const cronDesc = getCronDescription(draft.cronSchedule);

  const update = useCallback((patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    // Clear errors for changed fields
    const keys = Object.keys(patch);
    setErrors((e) => {
      const next = { ...e };
      for (const k of keys) delete next[k];
      return next;
    });
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

  return (
    <div className="space-y-6">
      {/* Header with save */}
      <div className="flex items-center gap-3">
        {dirty && <Badge variant="secondary">Unsaved changes</Badge>}
        {flash && <Badge variant="default">{flash}</Badge>}
        {errors.general && <span className="text-sm text-destructive">{errors.general}</span>}
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Label className="text-sm text-muted-foreground">Enabled</Label>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(checked) => update({ enabled: !!checked })}
            />
          </div>
          <Button onClick={() => void handleSave()} disabled={!dirty || saving} size="sm">
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      {/* Name + Description */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="skill-name">Name</Label>
          <Input
            id="skill-name"
            value={draft.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="skill-name"
          />
          {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="skill-description">Description</Label>
          <Input
            id="skill-description"
            value={draft.description}
            onChange={(e) => update({ description: e.target.value })}
            placeholder="What this skill does"
          />
          {errors.description && <p className="text-xs text-destructive">{errors.description}</p>}
        </div>
      </div>

      {/* Prompt */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="skill-prompt">Prompt</Label>
          <span className="text-xs text-muted-foreground">{draft.prompt.length} chars</span>
        </div>
        <Textarea
          id="skill-prompt"
          value={draft.prompt}
          onChange={(e) => update({ prompt: e.target.value })}
          placeholder="Execution instructions for the skill..."
          className="min-h-[200px] font-mono text-sm"
          style={{ fieldSizing: "content" } as React.CSSProperties}
        />
        {errors.prompt && <p className="text-xs text-destructive">{errors.prompt}</p>}
      </div>

      {/* Cron + Report Mode */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="skill-cron">Cron Schedule</Label>
          <Input
            id="skill-cron"
            value={draft.cronSchedule}
            onChange={(e) => update({ cronSchedule: e.target.value })}
            placeholder="e.g. 0 9 * * * (leave empty for on-demand)"
            className="font-mono"
          />
          {draft.cronSchedule && (
            <p className={`text-xs ${cronDesc ? "text-muted-foreground" : "text-destructive"}`}>
              {cronDesc ?? "Invalid cron expression"}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="skill-report-mode">Report Mode</Label>
          <Select
            id="skill-report-mode"
            value={draft.reportMode}
            onChange={(e) =>
              update({
                reportMode: e.target.value as "always" | "alert",
              })
            }
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
      {errors.parameters && <p className="text-xs text-destructive">{errors.parameters}</p>}

      {/* Metadata */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground border-t border-border pt-4">
        <span>Version: {skill.version}</span>
        <span>Chat: {skill.chatId}</span>
        <span>Created: {new Date(skill.createdAt).toLocaleDateString()}</span>
        <span>Updated: {new Date(skill.updatedAt).toLocaleDateString()}</span>
        {skill.nextRunAt && <span>Next run: {new Date(skill.nextRunAt).toLocaleString()}</span>}
      </div>
    </div>
  );
}
