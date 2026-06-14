"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ListField } from "./list-field";
import type { SkillListItem } from "@/lib/skill-schema";

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
  body: string;
  triggers: string[];
  tags: string[];
  enabled: boolean;
  source: "manual" | "distilled" | "imported";
}

function skillToDraft(skill: SkillListItem): Draft {
  return {
    name: skill.name,
    description: skill.description,
    body: skill.body,
    triggers: skill.triggers,
    tags: skill.tags,
    enabled: skill.enabled,
    source: skill.source,
  };
}

function clean(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function normalizeDraft(draft: Draft): Draft {
  return {
    ...draft,
    triggers: clean(draft.triggers),
    tags: clean(draft.tags),
  };
}

function isDirty(draft: Draft, saved: Draft): boolean {
  return JSON.stringify(normalizeDraft(draft)) !== JSON.stringify(normalizeDraft(saved));
}

export function SkillEditor({ skill }: SkillEditorProps) {
  const [saved, setSaved] = useState<Draft>(() => skillToDraft(skill));
  const [draft, setDraft] = useState<Draft>(() => skillToDraft(skill));
  // Track the live version across saves so each PATCH CASes on the version this
  // editor last knew about — a stale or racing save then 409s instead of
  // silently clobbering another edit (and dropping its history snapshot).
  const [version, setVersion] = useState(skill.version);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<string | null>(null);
  const saveRef = useRef<() => void>(() => {});

  const dirty = isDirty(draft, saved);

  const update = useCallback((patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    const keys = Object.keys(patch);
    setErrors((current) => {
      const next = { ...current };
      for (const key of keys) delete next[key];
      return next;
    });
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  async function handleSave() {
    setSaving(true);
    setErrors({});

    const normalizedDraft = normalizeDraft(draft);
    const normalizedSaved = normalizeDraft(saved);
    const body: Record<string, unknown> = {};
    if (normalizedDraft.name !== normalizedSaved.name) body.name = normalizedDraft.name;
    if (normalizedDraft.description !== normalizedSaved.description) {
      body.description = normalizedDraft.description;
    }
    if (normalizedDraft.body !== normalizedSaved.body) body.body = normalizedDraft.body;
    if (JSON.stringify(normalizedDraft.triggers) !== JSON.stringify(normalizedSaved.triggers)) {
      body.triggers = normalizedDraft.triggers;
    }
    if (JSON.stringify(normalizedDraft.tags) !== JSON.stringify(normalizedSaved.tags)) {
      body.tags = normalizedDraft.tags;
    }
    if (normalizedDraft.enabled !== normalizedSaved.enabled) body.enabled = normalizedDraft.enabled;
    if (normalizedDraft.source !== normalizedSaved.source) body.source = normalizedDraft.source;
    body.expectedVersion = version;

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
      setVersion(data.skill!.version);
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
      <div className="flex items-center gap-3">
        {dirty && <span className="text-xs font-medium text-primary">Unsaved changes</span>}
        {flash && <span className="text-xs font-medium text-primary/60">{flash}</span>}
        {errors.general && (
          <span className="text-xs text-destructive-foreground">{errors.general}</span>
        )}
        <div className="ml-auto flex items-center gap-4">
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
            onChange={(event) => update({ name: event.target.value })}
            placeholder="skill-name"
            className="font-mono"
          />
          {errors.name && <p className="text-xs text-destructive-foreground">{errors.name}</p>}
        </div>
        <div className="space-y-2">
          <Label
            htmlFor="skill-source"
            className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
          >
            Source
          </Label>
          <Select
            id="skill-source"
            value={draft.source}
            onChange={(event) =>
              update({ source: event.target.value as "manual" | "distilled" | "imported" })
            }
          >
            <option value="manual">Manual</option>
            <option value="distilled">Distilled</option>
            <option value="imported">Imported</option>
          </Select>
        </div>
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
          onChange={(event) => update({ description: event.target.value })}
          placeholder="When this guidance should be used"
        />
        {errors.description && (
          <p className="text-xs text-destructive-foreground">{errors.description}</p>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label
            htmlFor="skill-body"
            className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
          >
            Body
          </Label>
          <span className="text-[10px] tabular-nums text-faint">{draft.body.length} chars</span>
        </div>
        <Textarea
          id="skill-body"
          value={draft.body}
          onChange={(event) => update({ body: event.target.value })}
          placeholder="Reusable procedural guidance..."
          className="min-h-[260px] font-mono text-xs leading-relaxed"
          style={{ fieldSizing: "content" }}
        />
        {errors.body && <p className="text-xs text-destructive-foreground">{errors.body}</p>}
      </div>

      <div className="grid grid-cols-2 gap-6">
        <ListField
          id="skill-triggers"
          label="Triggers"
          values={draft.triggers}
          onChange={(triggers) => update({ triggers })}
          placeholder="when writing followups"
        />
        <ListField
          id="skill-tags"
          label="Tags"
          values={draft.tags}
          onChange={(tags) => update({ tags })}
          placeholder="writing"
        />
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border pt-6 text-[10px] uppercase tracking-[0.15em] text-faint">
        <span>v{version}</span>
        <span>Chat: {skill.chatId}</span>
        <span>Uses: {skill.usageCount}</span>
        {skill.lastUsedAt && (
          <span>Last used: {new Date(skill.lastUsedAt).toLocaleDateString()}</span>
        )}
        <span>Created: {new Date(skill.createdAt).toLocaleDateString()}</span>
        <span>Updated: {new Date(skill.updatedAt).toLocaleDateString()}</span>
      </div>
    </div>
  );
}
