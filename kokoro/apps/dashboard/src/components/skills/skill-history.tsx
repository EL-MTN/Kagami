"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { History, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SkillRevisionItem } from "@/lib/skill-schema";

interface SkillHistoryProps {
  skillId: string;
  currentVersion: number;
  revisions: SkillRevisionItem[];
}

const REASON_LABEL: Record<SkillRevisionItem["reason"], string> = {
  refine: "Curator refine",
  merge: "Curator merge",
  "manual-edit": "Manual edit",
  rollback: "Rollback",
  import: "Import",
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function SkillHistory({ skillId, currentVersion, revisions }: SkillHistoryProps) {
  const router = useRouter();
  const [target, setTarget] = useState<SkillRevisionItem | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRestore() {
    if (!target) return;
    setRestoring(true);
    setError(null);
    try {
      const res = await fetch(`/api/skills/${skillId}/revisions/${target.version}`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Failed to restore version");
        return;
      }
      setTarget(null);
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <div className="mb-4 flex items-center gap-2">
        <History className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-display text-lg text-foreground">Version history</h3>
        <span className="text-xs text-faint">
          current v{currentVersion}
          {revisions.length > 0 && ` · ${revisions.length} prior`}
        </span>
      </div>

      {revisions.length === 0 ? (
        <p className="text-xs text-faint">
          No prior versions — this skill hasn&apos;t had a content edit since history tracking
          began. Curator refinements, merges, and manual content edits are recorded here and can be
          restored.
        </p>
      ) : (
        <ol className="space-y-3">
          {revisions.map((revision) => (
            <li
              key={revision.version}
              className="rounded-lg border border-border/60 bg-background/40 p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-muted-foreground">v{revision.version}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                      {REASON_LABEL[revision.reason]}
                    </span>
                    <span className="text-faint">superseded {formatWhen(revision.takenAt)}</span>
                  </div>
                  {revision.note && (
                    <p className="text-xs text-muted-foreground">{revision.note}</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setError(null);
                    setTarget(revision);
                  }}
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  Restore
                </Button>
              </div>
              <details className="mt-3 group">
                <summary className="cursor-pointer text-[10px] uppercase tracking-[0.15em] text-faint hover:text-muted-foreground">
                  View content
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-background/60 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {revision.body}
                </pre>
              </details>
            </li>
          ))}
        </ol>
      )}

      <Dialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Restore version</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Restore this skill&apos;s content to{" "}
              <span className="font-medium text-foreground">v{target?.version}</span>? The current
              version (v{currentVersion}) is snapshotted first, so this is itself reversible. The
              name and enabled state are left unchanged.
            </p>
            {error && <p className="text-xs text-destructive-foreground">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTarget(null)} disabled={restoring}>
              Cancel
            </Button>
            <Button onClick={() => void handleRestore()} disabled={restoring}>
              {restoring ? "Restoring..." : "Restore"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
