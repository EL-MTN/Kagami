"use client";

import { useState } from "react";
import { describeCron } from "@/lib/cron-format";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Plus } from "lucide-react";
import type { WatcherListItem } from "@/lib/watcher-schema";

interface ApiWatcherResponse {
  error?: string;
  issues?: { path?: string[]; message: string }[];
  watcher?: WatcherListItem;
}

interface WatcherCreateDialogProps {
  knownChatIds: string[];
  onCreated: (watcher: WatcherListItem) => void;
}

const NEW_CHAT_SENTINEL = "__new__";

export function WatcherCreateDialog({ knownChatIds, onCreated }: WatcherCreateDialogProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const defaultChatId = knownChatIds[0] ?? "";
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cronSchedule, setCronSchedule] = useState("");
  const [oneShot, setOneShot] = useState(false);
  const [maxFiresRaw, setMaxFiresRaw] = useState("");
  const [cooldownMinutesRaw, setCooldownMinutesRaw] = useState("");
  const [chatIdMode, setChatIdMode] = useState<string>(defaultChatId || NEW_CHAT_SENTINEL);
  const [newChatId, setNewChatId] = useState("");

  const chatId = chatIdMode === NEW_CHAT_SENTINEL ? newChatId : chatIdMode;

  function reset() {
    setName("");
    setDescription("");
    setPrompt("");
    setCronSchedule("");
    setOneShot(false);
    setMaxFiresRaw("");
    setCooldownMinutesRaw("");
    setChatIdMode(defaultChatId || NEW_CHAT_SENTINEL);
    setNewChatId("");
    setErrors({});
  }

  async function handleCreate() {
    setSaving(true);
    setErrors({});

    const maxFires = maxFiresRaw.trim() ? Math.max(1, Math.floor(Number(maxFiresRaw))) : null;
    const cooldownMs = cooldownMinutesRaw.trim()
      ? Math.max(0, Math.floor(Number(cooldownMinutesRaw))) * 60_000
      : null;

    try {
      const res = await fetch("/api/watchers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId,
          name,
          description,
          prompt,
          cronSchedule,
          oneShot,
          maxFires,
          cooldownMs,
        }),
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
          setErrors({ general: data.error ?? "Failed to create watcher" });
        }
        return;
      }

      onCreated(data.watcher!);
      setOpen(false);
      reset();
    } catch {
      setErrors({ general: "Network error" });
    } finally {
      setSaving(false);
    }
  }

  const cronDesc = describeCron(cronSchedule);
  const canCreate = name && description && prompt && cronSchedule && chatId;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-3.5 w-3.5" />
          New Watcher
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Create Watcher</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {errors.general && (
            <p className="text-xs text-destructive-foreground">{errors.general}</p>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label
                htmlFor="watcher-create-name"
                className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
              >
                Name
              </Label>
              <Input
                id="watcher-create-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-watcher"
                className="font-mono"
              />
              {errors.name && <p className="text-xs text-destructive-foreground">{errors.name}</p>}
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="watcher-create-chatid"
                className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
              >
                Chat ID
              </Label>
              {knownChatIds.length > 0 ? (
                <Select
                  id="watcher-create-chatid"
                  value={chatIdMode}
                  onChange={(e) => setChatIdMode(e.target.value)}
                  className="font-mono"
                >
                  {knownChatIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                  <option value={NEW_CHAT_SENTINEL}>+ New chat…</option>
                </Select>
              ) : null}
              {(knownChatIds.length === 0 || chatIdMode === NEW_CHAT_SENTINEL) && (
                <Input
                  value={newChatId}
                  onChange={(e) => setNewChatId(e.target.value)}
                  placeholder="Telegram chat ID"
                  className="font-mono"
                />
              )}
              {errors.chatId && (
                <p className="text-xs text-destructive-foreground">{errors.chatId}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label
              htmlFor="watcher-create-description"
              className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
            >
              Description
            </Label>
            <Input
              id="watcher-create-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this watcher detects"
            />
            {errors.description && (
              <p className="text-xs text-destructive-foreground">{errors.description}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label
              htmlFor="watcher-create-prompt"
              className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
            >
              Detection Prompt
            </Label>
            <Textarea
              id="watcher-create-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What to check, what to compare against, what counts as a trigger..."
              className="min-h-[120px] font-mono text-xs"
            />
            {errors.prompt && (
              <p className="text-xs text-destructive-foreground">{errors.prompt}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label
              htmlFor="watcher-create-cron"
              className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
            >
              Schedule
            </Label>
            <Input
              id="watcher-create-cron"
              value={cronSchedule}
              onChange={(e) => setCronSchedule(e.target.value)}
              placeholder="0 * * * *"
              className="font-mono"
            />
            {cronSchedule && (
              <p
                className={`text-[11px] ${cronDesc ? "text-muted-foreground" : "text-destructive-foreground"}`}
              >
                {cronDesc ?? "Invalid cron expression"}
              </p>
            )}
          </div>

          <div className="grid grid-cols-3 gap-4 rounded-xl border border-border bg-card/40 p-4">
            <div className="space-y-2">
              <Label className="flex items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                One-shot
                <Switch checked={oneShot} onCheckedChange={(c) => setOneShot(!!c)} />
              </Label>
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="watcher-create-maxfires"
                className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
              >
                Max fires
              </Label>
              <Input
                id="watcher-create-maxfires"
                type="number"
                min={1}
                value={maxFiresRaw}
                onChange={(e) => setMaxFiresRaw(e.target.value)}
                placeholder="unlimited"
                className="font-mono"
                disabled={oneShot}
              />
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="watcher-create-cooldown"
                className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
              >
                Cooldown (min)
              </Label>
              <Input
                id="watcher-create-cooldown"
                type="number"
                min={1}
                value={cooldownMinutesRaw}
                onChange={(e) => setCooldownMinutesRaw(e.target.value)}
                placeholder="empty"
                className="font-mono"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setOpen(false);
              reset();
            }}
          >
            Cancel
          </Button>
          <Button onClick={() => void handleCreate()} disabled={!canCreate || saving}>
            {saving ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
