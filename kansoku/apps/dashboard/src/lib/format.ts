export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | (string & {});

export function formatTimestamp(input: string | Date): string {
  const d = typeof input === "string" ? new Date(input) : input;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function formatDateTime(input: string | Date): string {
  const d = typeof input === "string" ? new Date(input) : input;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatRelative(input: string | Date): string {
  const date = typeof input === "string" ? new Date(input) : input;
  const ms = Date.now() - date.getTime();
  if (ms < 1000) return "just now";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Tone used by the level badge + log row indicator. Maps pino's six levels
// onto the workspace's positive/info/caution/critical palette.
export type LevelTone = "neutral" | "info" | "positive" | "caution" | "critical";

export function levelTone(level: string): LevelTone {
  switch (level) {
    case "trace":
    case "debug":
      return "neutral";
    case "info":
      return "info";
    case "warn":
      return "caution";
    case "error":
    case "fatal":
      return "critical";
    default:
      return "neutral";
  }
}
