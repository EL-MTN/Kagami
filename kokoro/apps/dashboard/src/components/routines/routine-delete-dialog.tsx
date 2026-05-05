"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface RoutineDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  routineId: string;
  routineName: string;
  onDeleted: (id: string) => void;
}

export function RoutineDeleteDialog({
  open,
  onOpenChange,
  routineId,
  routineName,
  onDeleted,
}: RoutineDeleteDialogProps) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/routines/${routineId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        onDeleted(routineId);
        onOpenChange(false);
      }
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Delete Routine</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            This will permanently delete &ldquo;{routineName}&rdquo; and all its execution logs.
            This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
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
