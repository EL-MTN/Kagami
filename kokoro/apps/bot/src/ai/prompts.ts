import { config } from "@kokoro/shared";

type TimeOfDay = "late night" | "morning" | "afternoon" | "evening" | "night";

export function timeOfDayFor(now: Date): TimeOfDay {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: config.TIMEZONE,
    }).format(now),
  );
  if (hour < 6) return "late night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 21) return "evening";
  return "night";
}

export function moodForTimeOfDay(timeOfDay: TimeOfDay): string {
  switch (timeOfDay) {
    case "late night":
      return "Soft and quiet, a little sleepy. Gentle nudges toward rest.";
    case "morning":
      return "Energetic, ready to brief him on the day.";
    case "afternoon":
      return "Steady and focused.";
    case "evening":
      return "Warm and settled, more conversational.";
    case "night":
      return "Softer, more reflective, sometimes a bit sleepy.";
  }
}

export const DATETIME_CONTEXT = (now: Date): string => {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: config.TIMEZONE,
  };
  const formatted = now.toLocaleString("en-US", options);
  return `Current date and time: ${formatted}\nTime of day: ${timeOfDayFor(now)}`;
};

// Date-only context for the FROZEN system-prompt prefix (conversational +
// proactive paths). Deliberately omits the clock time so the system prompt
// changes at most once per day (plus the handful of time-of-day boundary
// crossings) instead of every message — keeping the provider's prompt cache
// warm across a conversation. The precise minute-level clock rides the message
// tail instead (see `currentTimeContext`). This mirrors how Claude Code keeps
// only the date in its system prompt. See docs/ai-layer.md.
export const DATE_CONTEXT = (now: Date): string => {
  const date = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: config.TIMEZONE,
  }).format(now);
  return `Today is ${date} (timezone: ${config.TIMEZONE}).\nTime of day: ${timeOfDayFor(now)}.`;
};

// Precise current time for the per-message TAIL injection (a trailing system
// message in `generate.ts`). Carries the clock to the minute plus the IANA zone
// and an ISO-8601 offset so the model can reason about boundaries ("is it still
// today?", "how long until midnight?"). Lives in the tail — which is new every
// turn anyway — so it never invalidates the cached system/tool/history prefix.
export const currentTimeContext = (now: Date): string => {
  const clock = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: config.TIMEZONE,
    hour12: true,
  }).format(now);
  return `Current time: ${clock} (${isoWithOffset(now, config.TIMEZONE)})`;
};

// Build an ISO-8601 timestamp WITH the zone's UTC offset (e.g.
// "2026-06-05T17:34:00-07:00") for an arbitrary IANA timezone. A plain `Date`
// exposes no offset for non-local zones, so derive the wall-clock parts and the
// offset from `Intl` and stitch them together. DST is handled automatically —
// the offset reflects whichever rule is in effect at `now`. Shared with the
// `getCurrentTime` tool so both render the offset identically.
export function isoWithOffset(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "00";
  // Some ICU builds emit "24" for midnight under hour12:false — normalize to "00".
  const hour = get("hour") === "24" ? "00" : get("hour");
  const offsetName =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  // "GMT-07:00" → "-07:00"; bare "GMT" (UTC) → "+00:00".
  const offset = offsetName === "GMT" ? "+00:00" : offsetName.replace("GMT", "");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}${offset}`;
}
