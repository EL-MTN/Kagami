"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ListField } from "./list-field";
import type { SkillListItem } from "@/lib/skill-schema";

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
  const [chatIdMode, setChatIdMode] = useState<string>(defaultChatId || NEW_CHAT_SENTINEL);
  const [newChatId, setNewChatId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [triggers, setTriggers] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);

  const chatId = chatIdMode === NEW_CHAT_SENTINEL ? newChatId : chatIdMode;

  function reset() {
    setChatIdMode(defaultChatId || NEW_CHAT_SENTINEL);
    setNewChatId("");
    setName("");
    setDescription("");
    setBody("");
    setTriggers([]);
    setTags([]);
    setErrors({});
  }

  function clean(values: string[]): string[] {
    return values.map((value) => value.trim()).filter(Boolean);
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
          body,
          triggers: clean(triggers),
          tags: clean(tags),
          source: "manual",
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

  const canCreate = Boolean(chatId && name && description && body);

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
                htmlFor="skill-create-name"
                className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
              >
                Name
              </Label>
              <Input
                id="skill-create-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="meeting-followup-style"
                className="font-mono"
              />
              {errors.name && <p className="text-xs text-destructive-foreground">{errors.name}</p>}
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="skill-create-chatid"
                className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
              >
                Chat ID
              </Label>
              {knownChatIds.length > 0 ? (
                <Select
                  id="skill-create-chatid"
                  value={chatIdMode}
                  onChange={(event) => setChatIdMode(event.target.value)}
                >
                  {knownChatIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                  <option value={NEW_CHAT_SENTINEL}>+ New chat...</option>
                </Select>
              ) : null}
              {(knownChatIds.length === 0 || chatIdMode === NEW_CHAT_SENTINEL) && (
                <Input
                  value={newChatId}
                  onChange={(event) => setNewChatId(event.target.value)}
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
              htmlFor="skill-create-description"
              className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
            >
              Description
            </Label>
            <Input
              id="skill-create-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="When this guidance should be used"
            />
            {errors.description && (
              <p className="text-xs text-destructive-foreground">{errors.description}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label
              htmlFor="skill-create-body"
              className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
            >
              Body
            </Label>
            <Textarea
              id="skill-create-body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Reusable procedural guidance..."
              className="min-h-[160px] font-mono text-xs leading-relaxed"
            />
            {errors.body && <p className="text-xs text-destructive-foreground">{errors.body}</p>}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <ListField
              id="skill-create-triggers"
              label="Triggers"
              values={triggers}
              onChange={setTriggers}
              placeholder="after a sales call"
            />
            <ListField
              id="skill-create-tags"
              label="Tags"
              values={tags}
              onChange={setTags}
              placeholder="writing"
            />
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
