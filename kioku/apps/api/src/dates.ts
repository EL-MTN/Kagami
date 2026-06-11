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

// Exact UTC midnight ⇒ almost certainly a bare calendar date that a
// YAML parser inflated into an instant — js-yaml turns an unquoted
// `started_at: 2026-05-15` into `Date.UTC(2026, 4, 15)` and types.ts
// stringifies that to "2026-05-15T00:00:00.000Z". A calendar date must
// keep its named day, not shift west of Greenwich. The cost: a true
// instant landing on 00:00:00.000Z exactly also collapses to its UTC
// date, which matches the legacy slice behavior.
function calendarDayOf(d: Date): string {
  return d.getTime() % 86_400_000 === 0 ? d.toISOString().slice(0, 10) : localDateOf(d);
}

// Session timestamps arrive as frontmatter `started_at` in assorted
// shapes: a true instant ("2026-05-15T06:01:59.210Z"), a naive local
// datetime, a bare date, or a YAML-inflated UTC-midnight instant.
// Convert real instants to the local calendar day; keep date-only
// values (verbatim or YAML-inflated) on their named day; fall back to
// the legacy 10-char slice for anything unparsable so longmemeval-style
// frontmatter keeps its historical behavior.
export function sessionDateOf(value: unknown): string {
  if (value instanceof Date) return calendarDayOf(value);
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return s.slice(0, 10);
  return calendarDayOf(parsed);
}
