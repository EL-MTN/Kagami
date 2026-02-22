import { readVaultFile } from "../memory/vault.js";
import { CalendarEvent } from "../db/models/calendar-event.js";
import type { CalendarEvent as CalEvent, CalendarQuery } from "./types.js";

function parseVaultEvents(content: string): CalEvent[] {
  const events: CalEvent[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    // Format: - YYYY-MM-DD | Event description | optional notes
    const match = line.match(
      /^-\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(.+?)(?:\s*\|\s*(.+))?$/,
    );
    if (match) {
      events.push({
        date: match[1],
        title: match[2].trim(),
        notes: match[3]?.trim(),
        source: "vault",
      });
    }
  }

  return events;
}

export async function queryCalendarEvents(
  query: CalendarQuery,
): Promise<CalEvent[]> {
  const results: CalEvent[] = [];

  // 1. Check vault events
  const vaultFile = await readVaultFile("calendar/events.md");
  if (vaultFile) {
    const vaultEvents = parseVaultEvents(vaultFile.content);
    results.push(...vaultEvents);
  }

  // 2. Check DB events
  const dbFilter: Record<string, unknown> = {};
  if (query.startDate || query.endDate) {
    dbFilter.date = {};
    if (query.startDate) {
      (dbFilter.date as Record<string, unknown>).$gte = new Date(
        query.startDate,
      );
    }
    if (query.endDate) {
      (dbFilter.date as Record<string, unknown>).$lte = new Date(
        query.endDate,
      );
    }
  }

  const dbEvents = await CalendarEvent.find(dbFilter).sort({ date: 1 });
  for (const evt of dbEvents) {
    results.push({
      date: evt.date.toISOString().split("T")[0],
      title: evt.title,
      notes: evt.notes,
      source: "db",
    });
  }

  // 3. Filter by query keyword if provided
  if (query.query) {
    const q = query.query.toLowerCase();
    return results.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.notes?.toLowerCase().includes(q),
    );
  }

  // 4. Filter by date range for vault events
  if (query.startDate || query.endDate) {
    return results.filter((e) => {
      if (query.startDate && e.date < query.startDate) return false;
      if (query.endDate && e.date > query.endDate) return false;
      return true;
    });
  }

  return results;
}
