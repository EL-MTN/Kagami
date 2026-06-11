// Local-calendar date helpers for day-granular `event_date` values.
//
// Facts carry YYYY-MM-DD event dates that the answerer resolves
// newest-wins, so "today" must be the operator's local calendar day.
// `new Date().toISOString().slice(0, 10)` is UTC: after 5 PM PDT it
// names tomorrow, which stamped every evening conversation one day
// into the future and fed the newest-wins contradiction logic a wrong
// ordering. Same defect applied to slicing a transcript's `started_at`
// instant — a 11 PM PDT session sliced to the next day's date.

export function localDateOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function localToday(): string {
  return localDateOf(new Date());
}

// Session timestamps arrive as frontmatter `started_at` in assorted
// shapes: a true instant ("2026-05-15T06:01:59.210Z"), a naive local
// datetime, or a bare date. Convert parsable timestamps to the local
// calendar day; keep date-only values verbatim (running them through
// `new Date` would reinterpret them as UTC midnight and shift them back
// a day anywhere west of Greenwich); fall back to the legacy 10-char
// slice for anything unparsable so longmemeval-style frontmatter keeps
// its historical behavior.
export function sessionDateOf(value: unknown): string {
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return s.slice(0, 10);
  return localDateOf(parsed);
}
