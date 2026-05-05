"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SnoozeButtonProps {
  watcherId: string;
  snoozedUntil: string | null;
}

const PRESETS: { label: string; hours: number }[] = [
  { label: "1 hour", hours: 1 },
  { label: "4 hours", hours: 4 },
  { label: "24 hours", hours: 24 },
  { label: "1 week", hours: 24 * 7 },
];

export function SnoozeButton({ watcherId, snoozedUntil }: SnoozeButtonProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const isSnoozed = !!snoozedUntil && new Date(snoozedUntil).getTime() > Date.now();

  // Close popover on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  async function applySnooze(hours: number | null) {
    setPending(true);
    try {
      const body =
        hours == null
          ? { snoozedUntil: null }
          : { snoozedUntil: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString() };
      const res = await fetch(`/api/watchers/${watcherId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) router.refresh();
    } finally {
      setPending(false);
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => setOpen((v) => !v)}
        className={isSnoozed ? "text-muted-foreground" : undefined}
      >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : isSnoozed ? (
          <BellOff className="h-3.5 w-3.5" />
        ) : (
          <Bell className="h-3.5 w-3.5" />
        )}
        {isSnoozed && snoozedUntil
          ? `Snoozed · ${new Date(snoozedUntil).toLocaleString()}`
          : "Snooze"}
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-md border border-border bg-card shadow-lg">
          <ul className="py-1 text-sm">
            {PRESETS.map((p) => (
              <li key={p.hours}>
                <button
                  type="button"
                  onClick={() => void applySnooze(p.hours)}
                  disabled={pending}
                  className="block w-full px-3 py-1.5 text-left text-xs text-foreground/80 transition-colors hover:bg-primary/[0.04]"
                >
                  {p.label}
                </button>
              </li>
            ))}
            {isSnoozed && (
              <li className="border-t border-border">
                <button
                  type="button"
                  onClick={() => void applySnooze(null)}
                  disabled={pending}
                  className="block w-full px-3 py-1.5 text-left text-xs text-destructive-foreground transition-colors hover:bg-destructive/10"
                >
                  Clear snooze
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
