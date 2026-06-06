export function fmtNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function fmtRelative(iso: string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (abs < minute) return "just now";
  if (abs < hour) return `${Math.round(diffMs / minute)}m ago`;
  if (abs < day) return `${Math.round(diffMs / hour)}h ago`;
  return `${Math.round(diffMs / day)}d ago`;
}

export function shortError(message: string, max = 180): string {
  const compact = message.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}
