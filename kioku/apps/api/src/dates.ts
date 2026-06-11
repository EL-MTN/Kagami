import { loadEnv } from "./config.js";

// Local-calendar date helpers for day-granular `event_date` values.
//
// Facts carry YYYY-MM-DD event dates that the answerer resolves
// newest-wins, so "today" must be the OPERATOR's calendar day.
// `new Date().toISOString().slice(0, 10)` is UTC: after 5 PM PDT it
// names tomorrow, which stamped every evening conversation one day
// into the future and fed the newest-wins contradiction logic a wrong
// ordering. Same defect applied to slicing a transcript's `started_at`
// instant — a 11 PM PDT session sliced to the next day's date.
//
// "Operator's day" is KIOKU_TIMEZONE (IANA name) when set, else the
// process timezone — on a personal machine those agree, but a UTC
// server MUST set KIOKU_TIMEZONE or the UTC-slice bug reappears wearing
// a different hat.

let fmtCache: { tz: string | undefined; fmt: Intl.DateTimeFormat } | null = null;
function dayFormatter(): Intl.DateTimeFormat {
  const tz = loadEnv().KIOKU_TIMEZONE;
  if (!fmtCache || fmtCache.tz !== tz) {
    // en-CA renders YYYY-MM-DD; timeZone undefined ⇒ process zone.
    fmtCache = {
      tz,
      fmt: new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
    };
  }
  return fmtCache.fmt;
}

export function localDateOf(d: Date): string {
  return dayFormatter().format(d);
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
  // An offsetless ISO datetime is wall time in the operator's zone, so
  // its literal date IS the calendar day. Parsing it through `new Date`
  // would interpret it in the PROCESS zone and re-introduce the
  // off-by-one for early-morning transcripts on any host whose zone
  // differs from KIOKU_TIMEZONE (e.g. a UTC server).
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    return s.slice(0, 10);
  }
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return s.slice(0, 10);
  return calendarDayOf(parsed);
}
