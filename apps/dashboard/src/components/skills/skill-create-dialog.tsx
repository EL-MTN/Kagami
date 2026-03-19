"use client";

import { useState } from "react";
import cronstrue from "cronstrue";
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
  skill?: SkillListItem;
}

interface SkillCreateDialogProps {
  defaultChatId: string;
  onCreated: (skill: SkillListItem) => void;
}

export function SkillCreateDialog({ defaultChatId, onCreated }: SkillCreateDialogProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [parameters, setParameters] = useState<SkillParameter[]>([]);
  const [cronSchedule, setCronSchedule] = useState("");
  const [reportMode, setReportMode] = useState<"always" | "alert">("always");
  const [chatId, setChatId] = useState(defaultChatId);

  function reset() {
    setName("");
    setDescription("");
    setPrompt("");
    setParameters([]);
    setCronSchedule("");
    setReportMode("always");
    setChatId(defaultChatId);
    setError(null);
  }

  function getCronDesc(): string | null {
    if (!cronSchedule) return null;
    try {
      return cronstrue.toString(cronSchedule, {
        use24HourTimeFormat: false,
        verbose: true,
      });
    } catch {
      return null;
    }
  }

  async function handleCreate() {
    setSaving(true);
    setError(null);

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
        }),
      });

      const data = (await res.json()) as ApiSkillResponse;

      if (!res.ok) {
        setError(data.error ?? "Failed to create skill");
        return;
      }

      onCreated(data.skill!);
      setOpen(false);
      reset();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  const cronDesc = getCronDesc();
  const canCreate = name && description && prompt;

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
          <Plus className="h-4 w-4" />
          New Skill
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Skill</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="create-name">Name</Label>
              <Input
                id="create-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-skill"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-chatid">Chat ID</Label>
              <Input
                id="create-chatid"
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="create-description">Description</Label>
            <Input
              id="create-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this skill does"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="create-prompt">Prompt</Label>
            <Textarea
              id="create-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Execution instructions..."
              className="min-h-[120px] font-mono text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="create-cron">Cron Schedule</Label>
              <Input
                id="create-cron"
                value={cronSchedule}
                onChange={(e) => setCronSchedule(e.target.value)}
                placeholder="optional"
                className="font-mono"
              />
              {cronSchedule && (
                <p className={`text-xs ${cronDesc ? "text-muted-foreground" : "text-destructive"}`}>
                  {cronDesc ?? "Invalid cron expression"}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-report-mode">Report Mode</Label>
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
