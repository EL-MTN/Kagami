"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, Trash2 } from "lucide-react";
import { LogRow } from "@/components/log-row";
import { EmptyState } from "@/components/shell";
import { cn } from "@/lib/utils";
import type { StoredLog } from "@/lib/api";

interface TailClientProps {
  apiBase: string;
}

type ConnectionState = "connecting" | "open" | "closed";

const LEVEL_OPTIONS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
const MAX_RENDERED = 1000;

export function TailClient({ apiBase }: TailClientProps) {
  const [service, setService] = useState("");
  const [levels, setLevels] = useState<Set<string>>(new Set(["info", "warn", "error", "fatal"]));
  const [paused, setPaused] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("closed");
  const [logs, setLogs] = useState<StoredLog[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const params = new URLSearchParams();
    if (service) params.set("service", service);
    if (levels.size > 0 && levels.size < LEVEL_OPTIONS.length) {
      params.set("level", [...levels].join(","));
    }
    params.set("replay", "100");

    const url = `${apiBase}/v1/tail?${params.toString()}`;
    setConnection("connecting");
    const es = new EventSource(url);

    es.onopen = () => setConnection("open");
    es.onerror = () => setConnection("closed");
    es.onmessage = (ev: MessageEvent<string>) => {
      if (pausedRef.current) return;
      try {
        const doc = JSON.parse(ev.data) as StoredLog;
        setLogs((prev) => {
          const next = [...prev, doc];
          return next.length > MAX_RENDERED ? next.slice(next.length - MAX_RENDERED) : next;
        });
      } catch {
        /* ignore malformed event */
      }
    };

    return () => {
      es.close();
      setConnection("closed");
    };
  }, [apiBase, service, levels]);

  const toggleLevel = useCallback((level: string) => {
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4 rounded-lg border border-border bg-card p-4">
        <label className="flex flex-col gap-1 text-[11px] tracking-wider text-faint uppercase">
          Service
          <input
            value={service}
            onChange={(e) => setService(e.target.value)}
            placeholder="all"
            className="w-40 rounded-md border border-input bg-background px-3 py-1.5 font-mono text-sm text-foreground focus:border-primary focus:outline-none"
          />
        </label>

        <div className="flex flex-col gap-1 text-[11px] tracking-wider text-faint uppercase">
          Levels
          <div className="flex flex-wrap gap-1">
            {LEVEL_OPTIONS.map((lvl) => {
              const on = levels.has(lvl);
              return (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => toggleLevel(lvl)}
                  className={cn(
                    "rounded-md border px-2 py-1 font-mono text-[11px] transition-colors",
                    on
                      ? "border-primary/30 bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  {lvl}
                </button>
              );
            })}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
              paused
                ? "border-[color:var(--color-caution)]/30 bg-[color:var(--color-caution)]/10 text-[color:var(--color-caution)]"
                : "border-border bg-background text-muted-foreground hover:text-foreground",
            )}
          >
            {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            type="button"
            onClick={() => setLogs([])}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <Trash2 className="h-3 w-3" />
            Clear
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between text-[11px] tabular-nums text-faint">
        <span className="inline-flex items-center gap-2">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              connection === "open"
                ? "bg-[color:var(--color-positive)]"
                : connection === "connecting"
                  ? "bg-[color:var(--color-caution)]"
                  : "bg-[color:var(--color-critical)]",
            )}
            style={
              connection === "open" ? { animation: "pulse 2s ease-in-out infinite" } : undefined
            }
          />
          {connection === "open"
            ? "streaming"
            : connection === "connecting"
              ? "connecting"
              : "disconnected"}
        </span>
        <span>{logs.length.toLocaleString()} lines</span>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {logs.length === 0 ? (
          <EmptyState>Waiting for log events…</EmptyState>
        ) : (
          <div className="max-h-[70vh] overflow-y-auto">
            {logs.map((log, i) => (
              <LogRow key={`${log.ts}-${i}`} log={log} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
