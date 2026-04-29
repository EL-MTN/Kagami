"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { WatcherRunButton } from "./watcher-run-button";
import { SnoozeButton } from "./snooze-button";
import { describeCron } from "@/lib/cron-format";
import type { WatcherListItem } from "@/lib/watcher-schema";

interface ApiErrorResponse {
  error?: string;
  issues?: { path?: string[]; message: string }[];
}

interface ApiWatcherResponse extends ApiErrorResponse {
  watcher?: WatcherListItem;
}

interface WatcherEditorProps {
  watcher: WatcherListItem;
}

interface Draft {
  name: string;
  description: string;
  prompt: string;
  cronSchedule: string;
  enabled: boolean;
  oneShot: boolean;
  maxFires: number | null;
  cooldownMinutes: number | null;
}

function watcherToDraft(w: WatcherListItem): Draft {
  return {
    name: w.name,
    description: w.description,
    prompt: w.prompt,
    cronSchedule: w.cronSchedule,
    enabled: w.enabled,
    oneShot: w.oneShot,
    maxFires: w.maxFires,
    cooldownMinutes: w.cooldownMs != null ? Math.round(w.cooldownMs / 60_000) : null,
  };
}

function isDirty(draft: Draft, saved: Draft): boolean {
  return JSON.stringify(draft) !== JSON.stringify(saved);
}

function parseOptionalInt(value: string, min = 0): number | null {
  if (!value.trim()) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const floored = Math.floor(n);
  return floored >= min ? floored : null;
}

export function WatcherEditor({ watcher }: WatcherEditorProps) {
  const [saved, setSaved] = useState<Draft>(() => watcherToDraft(watcher));
  const [draft, setDraft] = useState<Draft>(() => watcherToDraft(watcher));
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

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

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
    if (draft.enabled !== saved.enabled) body.enabled = draft.enabled;
    if (draft.cronSchedule !== saved.cronSchedule) body.cronSchedule = draft.cronSchedule;
    if (draft.oneShot !== saved.oneShot) body.oneShot = draft.oneShot;
    if (draft.maxFires !== saved.maxFires) body.maxFires = draft.maxFires;
    if (draft.cooldownMinutes !== saved.cooldownMinutes) {
      body.cooldownMs = draft.cooldownMinutes != null ? draft.cooldownMinutes * 60_000 : null;
    }

    try {
      const res = await fetch(`/api/watchers/${watcher.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = (await res.json()) as ApiWatcherResponse;

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

      const newSaved = watcherToDraft(data.watcher!);
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
      <div className="flex flex-wrap items-center gap-3">
        {dirty && <span className="text-xs font-medium text-primary">Unsaved changes</span>}
        {flash && <span className="text-xs font-medium text-primary/60">{flash}</span>}
        {errors.general && (
          <span className="text-xs text-destructive-foreground">{errors.general}</span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <SnoozeButton watcherId={watcher.id} snoozedUntil={watcher.snoozedUntil} />
          <WatcherRunButton
            watcherId={watcher.id}
            disabled={dirty || !draft.enabled}
            disabledReason={
              dirty
                ? "Save your changes before running"
                : !draft.enabled
                  ? "Enable the watcher to run it"
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
            htmlFor="watcher-name"
            className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
          >
            Name
          </Label>
          <Input
            id="watcher-name"
            value={draft.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="watcher-name"
            className="font-mono"
          />
          {errors.name && <p className="text-xs text-destructive-foreground">{errors.name}</p>}
        </div>
        <div className="space-y-2">
          <Label
            htmlFor="watcher-description"
            className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
          >
            Description
          </Label>
          <Input
            id="watcher-description"
            value={draft.description}
            onChange={(e) => update({ description: e.target.value })}
            placeholder="What this watcher detects"
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
            htmlFor="watcher-prompt"
            className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
          >
            Detection Prompt
          </Label>
          <span className="text-[10px] tabular-nums text-muted-foreground/40">
            {draft.prompt.length} chars
          </span>
        </div>
        <Textarea
          id="watcher-prompt"
          value={draft.prompt}
          onChange={(e) => update({ prompt: e.target.value })}
          placeholder="What to check, what to compare against, what counts as a trigger..."
          className="min-h-[200px] font-mono text-xs leading-relaxed"
          style={{ fieldSizing: "content" }}
        />
        {errors.prompt && <p className="text-xs text-destructive-foreground">{errors.prompt}</p>}
      </div>

      {/* Schedule */}
      <div className="space-y-2">
        <Label
          htmlFor="watcher-cron"
          className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
        >
          Schedule
        </Label>
        <Input
          id="watcher-cron"
          value={draft.cronSchedule}
          onChange={(e) => update({ cronSchedule: e.target.value })}
          placeholder="e.g. 0 * * * *"
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

      {/* Lifecycle controls */}
      <div className="space-y-4 rounded-xl border border-border bg-card/40 p-5">
        <div>
          <h4 className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
            Lifecycle
          </h4>
          <p className="mt-1 text-[11px] text-muted-foreground/50">
            Bound how often this watcher fires. Suppressed runs still detect and update state, but
            send no notification.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-6">
          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
              One-shot
              <Switch
                checked={draft.oneShot}
                onCheckedChange={(checked) => update({ oneShot: !!checked })}
              />
            </Label>
            <p className="text-[11px] text-muted-foreground/50">
              Archive after the first real fire.
            </p>
          </div>

          <div className="space-y-2">
            <Label
              htmlFor="watcher-maxfires"
              className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
            >
              Max fires
            </Label>
            <Input
              id="watcher-maxfires"
              type="number"
              min={1}
              value={draft.maxFires ?? ""}
              onChange={(e) => update({ maxFires: parseOptionalInt(e.target.value, 1) })}
              placeholder="unlimited"
              className="font-mono"
              disabled={draft.oneShot}
            />
            <p className="text-[11px] text-muted-foreground/50">
              Archive after this many fires. Empty = unlimited.
            </p>
          </div>

          <div className="space-y-2">
            <Label
              htmlFor="watcher-cooldown"
              className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
            >
              Cooldown (minutes)
            </Label>
            <Input
              id="watcher-cooldown"
              type="number"
              min={1}
              value={draft.cooldownMinutes ?? ""}
              onChange={(e) => update({ cooldownMinutes: parseOptionalInt(e.target.value, 1) })}
              placeholder="empty = no cooldown"
              className="font-mono"
            />
            <p className="text-[11px] text-muted-foreground/50">
              Min minutes between notifications. Empty = no cooldown.
            </p>
          </div>
        </div>
      </div>

      {/* Metadata footer */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border pt-6 text-[10px] uppercase tracking-[0.15em] text-muted-foreground/30">
        <span>v{watcher.version}</span>
        <span>Chat: {watcher.chatId}</span>
        <span>Fires: {watcher.fireCount}</span>
        <span>Created: {new Date(watcher.createdAt).toLocaleDateString()}</span>
        {watcher.lastFiredAt && (
          <span>Last fired: {new Date(watcher.lastFiredAt).toLocaleString()}</span>
        )}
        {watcher.nextRunAt && <span>Next: {new Date(watcher.nextRunAt).toLocaleString()}</span>}
        {watcher.expiresAt && (
          <span>Expires: {new Date(watcher.expiresAt).toLocaleDateString()}</span>
        )}
      </div>
    </div>
  );
}
