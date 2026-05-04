import { google } from "googleapis";
import { addDays } from "date-fns";
import { getGoogleAuth } from "./google-auth";
import { logger } from "@kokoro/shared";

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  location?: string;
  htmlLink: string;
}

export interface CreateEventParams {
  summary: string;
  description?: string;
  start: string;
  end: string;
  location?: string;
}

function getCalendar() {
  return google.calendar({ version: "v3", auth: getGoogleAuth() });
}

function toCalendarEvent(event: {
  id?: string | null;
  summary?: string | null;
  description?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null } | null;
  location?: string | null;
  htmlLink?: string | null;
}): CalendarEvent {
  return {
    id: event.id ?? "",
    summary: event.summary ?? "(no title)",
    description: event.description ?? undefined,
    start: event.start?.dateTime ?? event.start?.date ?? "",
    end: event.end?.dateTime ?? event.end?.date ?? "",
    location: event.location ?? undefined,
    htmlLink: event.htmlLink ?? "",
  };
}

export async function listUpcomingEvents(daysAhead = 7, maxResults = 10): Promise<CalendarEvent[]> {
  const calendar = getCalendar();

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: new Date().toISOString(),
    timeMax: addDays(new Date(), daysAhead).toISOString(),
    maxResults,
    singleEvents: true,
    orderBy: "startTime",
  });

  return (res.data.items ?? []).map(toCalendarEvent);
}

export async function createEvent(params: CreateEventParams): Promise<CalendarEvent> {
  const calendar = getCalendar();

  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: params.summary,
      description: params.description,
      start: { dateTime: params.start },
      end: { dateTime: params.end },
      location: params.location,
    },
  });

  logger.info({ eventId: res.data.id, summary: params.summary }, "Calendar event created");
  return toCalendarEvent(res.data);
}

export async function updateEvent(
  eventId: string,
  params: Partial<CreateEventParams>,
): Promise<CalendarEvent> {
  const calendar = getCalendar();

  const res = await calendar.events.patch({
    calendarId: "primary",
    eventId,
    requestBody: {
      summary: params.summary,
      description: params.description,
      start: params.start ? { dateTime: params.start } : undefined,
      end: params.end ? { dateTime: params.end } : undefined,
      location: params.location,
    },
  });

  logger.info({ eventId, summary: params.summary }, "Calendar event updated");
  return toCalendarEvent(res.data);
}

export async function deleteEvent(eventId: string): Promise<void> {
  const calendar = getCalendar();

  await calendar.events.delete({
    calendarId: "primary",
    eventId,
  });

  logger.info({ eventId }, "Calendar event deleted");
}
