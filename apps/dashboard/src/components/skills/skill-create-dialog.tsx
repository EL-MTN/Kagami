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
import { Textarea } from "@/components/ui/textarea";
import { ParameterEditor } from "./parameter-editor";
import { Plus } from "lucide-react";
import type { SkillListItem, SkillParameter } from "@/lib/skill-schema";

interface ApiSkillResponse {
  error?: string;
  issues?: { path?: string[]; message: string }[];
  skill?: SkillListItem;
}

interface SkillCreateDialogProps {
  knownChatIds: string[];
  onCreated: (skill: SkillListItem) => void;
}

const NEW_CHAT_SENTINEL = "__new__";

export function SkillCreateDialog({ knownChatIds, onCreated }: SkillCreateDialogProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const defaultChatId = knownChatIds[0] ?? "";
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [parameters, setParameters] = useState<SkillParameter[]>([]);
  const [cronSchedule, setCronSchedule] = useState("");
  const [reportMode, setReportMode] = useState<"always" | "alert">("always");
  const [purity, setPurity] = useState<"read" | "action">("action");
  const [chatIdMode, setChatIdMode] = useState<string>(defaultChatId || NEW_CHAT_SENTINEL);
  const [newChatId, setNewChatId] = useState("");

  const chatId = chatIdMode === NEW_CHAT_SENTINEL ? newChatId : chatIdMode;

  function reset() {
    setName("");
    setDescription("");
    setPrompt("");
    setParameters([]);
    setCronSchedule("");
    setReportMode("always");
    setPurity("action");
    setChatIdMode(defaultChatId || NEW_CHAT_SENTINEL);
    setNewChatId("");
    setErrors({});
  }

  async function handleCreate() {
    setSaving(true);
    setErrors({});

    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId,
          name,
          description,
          prompt,
          parameters,
          cronSchedule: cronSchedule || null,
          reportMode,
          purity,
        }),
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
          setErrors({ general: data.error ?? "Failed to create skill" });
        }
        return;
      }

      onCreated(data.skill!);
      setOpen(false);
      reset();
    } catch {
      setErrors({ general: "Network error" });
    } finally {
      setSaving(false);
    }
  }

  const cronDesc = describeCron(cronSchedule);
  const canCreate = name && description && prompt && chatId;

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
          New Skill
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Create Skill</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {errors.general && (
            <p className="text-xs text-destructive-foreground">{errors.general}</p>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label
                htmlFor="create-name"
                className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
              >
                Name
              </Label>
              <Input
                id="create-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-skill"
                className="font-mono"
              />
              {errors.name && <p className="text-xs text-destructive-foreground">{errors.name}</p>}
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="create-chatid"
                className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
              >
                Chat ID
              </Label>
              {knownChatIds.length > 0 ? (
                <Select
                  id="create-chatid"
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
              htmlFor="create-description"
              className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
            >
              Description
            </Label>
            <Input
              id="create-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this skill does"
            />
            {errors.description && (
              <p className="text-xs text-destructive-foreground">{errors.description}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label
              htmlFor="create-prompt"
              className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
            >
              Prompt
            </Label>
            <Textarea
              id="create-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Execution instructions..."
              className="min-h-[120px] font-mono text-xs"
            />
            {errors.prompt && (
              <p className="text-xs text-destructive-foreground">{errors.prompt}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label
                htmlFor="create-cron"
                className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
              >
                Cron Schedule
              </Label>
              <Input
                id="create-cron"
                value={cronSchedule}
                onChange={(e) => setCronSchedule(e.target.value)}
                placeholder="optional"
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
            <div className="space-y-2">
              <Label
                htmlFor="create-report-mode"
                className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
              >
                Report Mode
              </Label>
              <Select
                id="create-report-mode"
                value={reportMode}
                onChange={(e) => setReportMode(e.target.value as "always" | "alert")}
              >
                <option value="always">Always</option>
                <option value="alert">Alert only</option>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label
              htmlFor="create-purity"
              className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
            >
              Purity
            </Label>
            <Select
              id="create-purity"
              value={purity}
              onChange={(e) => setPurity(e.target.value as "read" | "action")}
            >
              <option value="action">Action — sends/writes (watchers cannot invoke)</option>
              <option value="read">Read — observation only (safe for watchers)</option>
            </Select>
          </div>

          <ParameterEditor parameters={parameters} onChange={setParameters} />
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
