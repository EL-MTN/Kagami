"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Trash2 } from "lucide-react";
import { LevelChips } from "@/components/level-chips";
import { LogRow } from "@/components/log-row";
import { ServiceSelect } from "@/components/service-select";
import { EmptyState } from "@/components/shell";
import { cn } from "@/lib/utils";
import type { StoredLog } from "@/lib/api";

interface TailClientProps {
  apiBase: string;
  services: string[];
}

type ConnectionState = "connecting" | "open" | "closed" | "muted";

const LEVEL_OPTIONS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
const MAX_RENDERED = 1000;
const REPLAY_ON_CONNECT = 100;

export function TailClient({ apiBase, services }: TailClientProps) {
  const [service, setService] = useState("");
  const [levels, setLevels] = useState<Set<string>>(new Set(["info", "warn", "error", "fatal"]));
  const [paused, setPaused] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("closed");
  const [logs, setLogs] = useState<{ seq: number; log: StoredLog }[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const seqRef = useRef(0);

  // Serialize the level set into a stable key so the effect deps don't churn
  // on every `new Set(...)` produced by `toggleLevel`. Without this, toggling
  // a level closes the SSE socket and re-opens (with a fresh 100-event
  // replay) on every click. The empty string encodes "no levels selected"
  // (a deliberate mute signal — never serialize all-levels to the wire).
  const levelKey = useMemo(() => [...levels].sort().join(","), [levels]);
  const allLevelsSelected = levels.size === LEVEL_OPTIONS.length;

  useEffect(() => {
    // A service/level change makes the current buffer stale — it was filled
    // under the previous filter, so e.g. narrowing levels would otherwise
    // leave already-rendered info lines on screen. Reset it on every (re)open
    // so the view only ever holds logs that match the active filter; the new
    // connection's replay repopulates it.
    setLogs([]);

    // Deselecting every level is a deliberate "show nothing" signal — open
    // no stream and render the muted state. (Previously this silently
    // omitted the `level=` param, which the server interpreted as "all
    // levels", inverting the user's intent.)
    if (levelKey === "") {
      setConnection("muted");
      return;
    }

    const params = new URLSearchParams();
    if (service) params.set("service", service);
    if (!allLevelsSelected) {
      params.set("level", levelKey);
    }
    params.set("replay", String(REPLAY_ON_CONNECT));

    const url = `${apiBase}/v1/tail?${params.toString()}`;
    setConnection("connecting");
    const es = new EventSource(url);

    es.onopen = () => setConnection("open");
    es.onerror = () => {
      // EventSource auto-reconnects on transient drops; the spec exposes
      // `readyState === CONNECTING` after a recoverable error. Map to
      // "connecting" so the indicator stays amber during reconnect instead
      // of flashing red while the browser is silently retrying.
      setConnection(es.readyState === EventSource.CLOSED ? "closed" : "connecting");
    };
    es.onmessage = (ev: MessageEvent<string>) => {
      if (pausedRef.current) return;
      try {
        const doc = JSON.parse(ev.data) as StoredLog;
        setLogs((prev) => {
          const next = [{ seq: seqRef.current++, log: doc }, ...prev];
          return next.length > MAX_RENDERED ? next.slice(0, MAX_RENDERED) : next;
        });
      } catch {
        /* ignore malformed event */
      }
    };

    return () => {
      es.close();
      setConnection("closed");
    };
  }, [apiBase, service, levelKey, allLevelsSelected]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4 rounded-lg border border-border bg-card p-4">
        <label className="flex flex-col gap-1 text-[11px] tracking-wider text-faint uppercase">
          Service
          <ServiceSelect
            value={service}
            onChange={setService}
            services={services}
            className="w-40"
          />
        </label>

        <div className="flex flex-col gap-1 text-[11px] tracking-wider text-faint uppercase">
          Levels
          <LevelChips value={levels} onChange={setLevels} />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
            aria-label={paused ? "Resume live tail" : "Pause live tail"}
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
            aria-label="Clear visible log lines"
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
                  : connection === "muted"
                    ? "bg-faint"
                    : "bg-[color:var(--color-critical)]",
            )}
            style={
              connection === "open"
                ? { animation: "pulse-soft 2s ease-in-out infinite" }
                : undefined
            }
          />
          {connection === "open"
            ? "streaming"
            : connection === "connecting"
              ? "connecting"
              : connection === "muted"
                ? "muted · no levels selected"
                : "disconnected"}
        </span>
        <span>{logs.length.toLocaleString()} lines</span>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {connection === "muted" ? (
          <EmptyState>Select at least one level to stream.</EmptyState>
        ) : logs.length === 0 ? (
          <EmptyState>Waiting for log events…</EmptyState>
        ) : (
          <div className="max-h-[70vh] overflow-y-auto">
            {logs.map(({ seq, log }) => (
              <LogRow key={seq} log={log} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
