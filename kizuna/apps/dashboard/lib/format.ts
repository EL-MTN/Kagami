const TZ = "America/New_York";

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const sec = Math.abs(diffMs) / 1000;
  const future = diffMs < 0;
  const fmt = (n: number, unit: string): string => {
    const out = `${Math.floor(n)}${unit}`;
    return future ? `in ${out}` : `${out} ago`;
  };
  if (sec < 60) return future ? "soon" : "just now";
  if (sec < 3600) return fmt(sec / 60, "m");
  if (sec < 86400) return fmt(sec / 3600, "h");
  if (sec < 86400 * 30) return fmt(sec / 86400, "d");
  return fmtDate(iso);
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
