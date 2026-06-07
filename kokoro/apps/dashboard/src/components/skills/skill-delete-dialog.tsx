"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface SkillDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skillId: string;
  skillName: string;
  onDeleted: (id: string) => void;
}

export function SkillDeleteDialog({
  open,
  onOpenChange,
  skillId,
  skillName,
  onDeleted,
}: SkillDeleteDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);

    try {
      const res = await fetch(`/api/skills/${skillId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Failed to delete skill");
        return;
      }
      onDeleted(skillId);
    } catch {
      setError("Network error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Delete Skill</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Delete <span className="font-medium text-foreground">{skillName}</span>?
          </p>
          {error && <p className="text-xs text-destructive-foreground">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
            {deleting ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
