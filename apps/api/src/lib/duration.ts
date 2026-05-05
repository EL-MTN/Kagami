// ISO 8601 duration parser (subset: weeks / days / hours).
// Also accepts the short forms "7d", "12h", "2w" (case-insensitive).

const ISO_RE = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?)?$/i;
const SHORT_RE = /^(\d+)([dhw])$/i;

export function parseDurationMs(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("empty duration");

  let normalized = trimmed.toUpperCase();
  const short = SHORT_RE.exec(trimmed);
  if (short) {
    const n = short[1]!;
    const unit = short[2]!.toUpperCase();
    normalized = unit === "H" ? `PT${n}H` : unit === "W" ? `P${n}W` : `P${n}D`;
  }

  const m = ISO_RE.exec(normalized);
  if (!m) throw new Error(`invalid duration: ${input}`);
  const weeks = m[1] ? Number(m[1]) : 0;
  const days = m[2] ? Number(m[2]) : 0;
  const hours = m[3] ? Number(m[3]) : 0;

  const ms = ((weeks * 7 + days) * 24 + hours) * 3_600_000;
  if (ms <= 0) throw new Error(`non-positive duration: ${input}`);
  return ms;
}
