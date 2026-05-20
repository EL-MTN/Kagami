// Time formatters shared with the sibling dashboards. Kept identical to keep
// "since 5m ago" mean the same thing across Kioku / Kokoro / Kizuna / Kansoku /
// Kao — operators move between them in the same session.

export function formatDateTime(input: string | Date | number): string {
  const d =
    typeof input === "string"
      ? new Date(input)
      : typeof input === "number"
        ? new Date(input)
        : input;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatRelative(input: string | Date | number): string {
  const date =
    typeof input === "number"
      ? new Date(input)
      : typeof input === "string"
        ? new Date(input)
        : input;
  const ms = Date.now() - date.getTime();
  const absMs = Math.abs(ms);
  if (absMs < 1000) return "just now";
  const secs = Math.round(absMs / 1000);
  const suffix = ms >= 0 ? "ago" : "from now";
  if (secs < 60) return `${secs}s ${suffix}`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ${suffix}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ${suffix}`;
  const days = Math.round(hours / 24);
  return `${days}d ${suffix}`;
}

// Used for the token probe: render the gap between now and the access token's
// expiresAt as "expires in 58m" so the operator can eyeball whether the cache
// just refreshed or this is a fresh-from-Google vend.
export function formatCountdown(input: number | Date | string): string {
  const target =
    typeof input === "number"
      ? input
      : typeof input === "string"
        ? new Date(input).getTime()
        : input.getTime();
  const ms = target - Date.now();
  if (ms <= 0) return "expired";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return `${hours}h`;
}
