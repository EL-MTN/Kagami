import { describe, expect, it } from 'vitest';
import { parseCalendarEvent, type CalendarEvent } from '../src/ingest/parse-event.js';

describe('parseCalendarEvent', () => {
  const baseStart = '2026-02-10T15:00:00-05:00';

  it('parses a simple confirmed event', () => {
    const ev: CalendarEvent = {
      id: 'evt-1',
      status: 'confirmed',
      summary: 'Q2 planning',
      description: 'review the deck',
      location: 'Acme HQ',
      start: { dateTime: baseStart },
      end: { dateTime: '2026-02-10T16:00:00-05:00' },
      organizer: { email: 'me@example.com', displayName: 'Me' },
      attendees: [
        { email: 'me@example.com', organizer: true, displayName: 'Me' },
        { email: 'sarah@acme.com', displayName: 'Sarah Connor' },
        { email: 'bob@bar.com' },
      ],
    };
    const p = parseCalendarEvent(ev);
    expect(p.id).toBe('evt-1');
    expect(p.title).toBe('Q2 planning');
    expect(p.body).toBe('review the deck');
    expect(p.location).toBe('Acme HQ');
    expect(p.cancelled).toBe(false);
    expect(p.occurredAt.toISOString()).toBe('2026-02-10T20:00:00.000Z');
    expect(p.organizer).toEqual({
      email: 'me@example.com',
      displayName: 'Me',
      isOrganizer: true,
    });
    // Organizer should not be re-listed in attendees
    expect(p.attendees.map((a) => a.email)).toEqual([
      'sarah@acme.com',
      'bob@bar.com',
    ]);
  });

  it('marks cancelled events with cancelled=true', () => {
    const ev: CalendarEvent = {
      id: 'evt-2',
      status: 'cancelled',
      summary: 'killed event',
      start: { dateTime: baseStart },
    };
    expect(parseCalendarEvent(ev).cancelled).toBe(true);
  });

  it('handles all-day events with a date-only start', () => {
    const ev: CalendarEvent = {
      id: 'evt-3',
      status: 'confirmed',
      summary: 'Conference Day',
      start: { date: '2026-03-15' },
      end: { date: '2026-03-16' },
    };
    expect(parseCalendarEvent(ev).occurredAt.toISOString()).toBe(
      '2026-03-15T00:00:00.000Z',
    );
  });

  it('lowercases attendee emails and dedupes', () => {
    const ev: CalendarEvent = {
      id: 'evt-4',
      status: 'confirmed',
      summary: 's',
      start: { dateTime: baseStart },
      attendees: [
        { email: 'Sarah@Acme.com' },
        { email: 'sarah@acme.com' },
        { email: 'bob@bar.com' },
      ],
    };
    expect(parseCalendarEvent(ev).attendees.map((a) => a.email)).toEqual([
      'sarah@acme.com',
      'bob@bar.com',
    ]);
  });

  it('falls back to "(no title)" when summary is missing', () => {
    const ev: CalendarEvent = {
      id: 'evt-5',
      status: 'confirmed',
      start: { dateTime: baseStart },
    };
    expect(parseCalendarEvent(ev).title).toBe('(no title)');
  });

  it('produces empty body when description is missing', () => {
    const ev: CalendarEvent = {
      id: 'evt-6',
      status: 'confirmed',
      summary: 's',
      start: { dateTime: baseStart },
    };
    expect(parseCalendarEvent(ev).body).toBe('');
  });
});
