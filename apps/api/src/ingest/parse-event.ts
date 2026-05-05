// Pure parser: Google Calendar event → normalized record.

export type CalendarEvent = {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    organizer?: boolean;
    self?: boolean;
    responseStatus?: string;
  }>;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  creator?: { email?: string; displayName?: string };
  recurringEventId?: string;
  htmlLink?: string;
};

export type ParsedAttendee = {
  email: string;
  displayName: string | null;
  isOrganizer: boolean;
};

export type ParsedEvent = {
  id: string;
  occurredAt: Date;
  title: string;
  body: string;
  location: string | null;
  cancelled: boolean;
  organizer: ParsedAttendee | null;
  attendees: ParsedAttendee[];
};

function parseStart(start: CalendarEvent["start"]): Date {
  if (!start) return new Date();
  if (start.dateTime) {
    const d = new Date(start.dateTime);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (start.date) {
    // All-day events: use midnight UTC of that date for stable ordering.
    const d = new Date(`${start.date}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function normalizeEmail(s: string | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim().toLowerCase();
  if (!trimmed.includes("@")) return null;
  return trimmed;
}

export function parseCalendarEvent(ev: CalendarEvent): ParsedEvent {
  const cancelled = ev.status === "cancelled";
  const title = ev.summary?.trim() || "(no title)";
  const body = ev.description ?? "";
  const location = ev.location?.trim() || null;
  const occurredAt = parseStart(ev.start);

  const seen = new Set<string>();
  const attendees: ParsedAttendee[] = [];

  let organizer: ParsedAttendee | null = null;
  const orgEmail = normalizeEmail(ev.organizer?.email);
  if (orgEmail) {
    organizer = {
      email: orgEmail,
      displayName: ev.organizer?.displayName ?? null,
      isOrganizer: true,
    };
    seen.add(orgEmail);
  }

  if (ev.attendees) {
    for (const a of ev.attendees) {
      const email = normalizeEmail(a.email);
      if (!email) continue;
      if (seen.has(email)) {
        // Already accounted for as organizer; nothing to do.
        continue;
      }
      seen.add(email);
      attendees.push({
        email,
        displayName: a.displayName ?? null,
        isOrganizer: Boolean(a.organizer),
      });
    }
  }

  return {
    id: ev.id,
    occurredAt,
    title,
    body,
    location,
    cancelled,
    organizer,
    attendees,
  };
}
