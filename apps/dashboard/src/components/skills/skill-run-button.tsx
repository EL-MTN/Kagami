"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Play, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SkillLogItem } from "@/lib/skill-schema";

interface SkillRunButtonProps {
  skillId: string;
  /** Disable the button (e.g. while the editor has unsaved changes). */
  disabled?: boolean;
  disabledReason?: string;
}

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 4 * 60_000; // 4 minutes — slightly above executor timeout

interface RunStatus {
  state: "idle" | "queued" | "running" | "completed" | "failed";
  message?: string;
}

export function SkillRunButton({ skillId, disabled, disabledReason }: SkillRunButtonProps) {
  const router = useRouter();
  const [status, setStatus] = useState<RunStatus>({ state: "idle" });
  const pollTimer = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const pollForResult = useCallback(
    (sinceMs: number, deadlineMs: number) => {
      const tick = async () => {
        if (Date.now() > deadlineMs) {
          setStatus({ state: "failed", message: "Timed out waiting for result" });
          return;
        }
        try {
          const res = await fetch(`/api/skills/${skillId}/logs?limit=5`, { cache: "no-store" });
          if (res.ok) {
            const data = (await res.json()) as { logs: SkillLogItem[] };
            const latest = data.logs.find(
              (l) => l.trigger === "manual" && new Date(l.startedAt).getTime() >= sinceMs - 1500,
            );
            if (latest) {
              if (latest.status === "completed") {
                setStatus({
                  state: "completed",
                  message: latest.summary?.slice(0, 200) ?? "(no output)",
                });
                router.refresh();
                return;
              }
              if (latest.status === "failed") {
                setStatus({ state: "failed", message: latest.summary ?? "Skill failed" });
                router.refresh();
                return;
              }
              if (latest.status === "running") {
                setStatus({ state: "running" });
              }
            }
          }
        } catch {
          // Transient error — keep polling.
        }
        pollTimer.current = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
      };
      pollTimer.current = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
    },
    [router, skillId],
  );

  const handleRun = useCallback(async () => {
    stopPolling();
    setStatus({ state: "queued" });
    const startedAt = Date.now();

    try {
      const res = await fetch(`/api/skills/${skillId}/run`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus({ state: "failed", message: data.error ?? "Failed to queue run" });
        return;
      }
      pollForResult(startedAt, startedAt + POLL_TIMEOUT_MS);
    } catch {
      setStatus({ state: "failed", message: "Network error" });
    }
  }, [pollForResult, skillId, stopPolling]);

  const isBusy = status.state === "queued" || status.state === "running";
  const buttonDisabled = disabled || isBusy;
  const buttonTitle = disabled ? disabledReason : undefined;

  return (
    <div className="flex items-center gap-3">
      {status.state === "queued" && (
        <span className="text-xs text-muted-foreground/60">Queued — waiting for bot…</span>
      )}
      {status.state === "running" && (
        <span className="text-xs text-muted-foreground/60">Running…</span>
      )}
      {status.state === "completed" && (
        <span className="max-w-md truncate text-xs text-primary/70" title={status.message}>
          ✓ {status.message}
        </span>
      )}
      {status.state === "failed" && (
        <span className="max-w-md truncate text-xs text-destructive-foreground" title={status.message}>
          ✗ {status.message}
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void handleRun()}
        disabled={buttonDisabled}
        title={buttonTitle}
      >
        {isBusy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Play className="h-3.5 w-3.5" />
        )}
        Run
      </Button>
    </div>
  );
}
