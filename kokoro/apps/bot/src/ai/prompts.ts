import { config } from "@kokoro/shared";

export type TimeOfDay = "late night" | "morning" | "afternoon" | "evening" | "night";

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
