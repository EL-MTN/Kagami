import { http, HttpResponse, type RequestHandler } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

/**
 * Default MSW handlers covering the external HTTP surfaces Mashiro talks to.
 * Tests can override these per-suite by passing `server.use(http.X(...))`.
 *
 * These defaults intentionally return minimal happy-path responses; suites
 * that exercise error paths should override.
 */
export const defaultHandlers = [
  // Whisper / OpenAI STT
  http.post("https://api.openai.com/v1/audio/transcriptions", () =>
    HttpResponse.json({ text: "stub transcription", duration: 1.5 }),
  ),
  // Gmail
  http.post("https://gmail.googleapis.com/gmail/v1/users/:userId/messages/send", () =>
    HttpResponse.json({ id: "stub-msg-id", threadId: "stub-thread-id" }),
  ),
  // Google Calendar
  http.post("https://www.googleapis.com/calendar/v3/calendars/:calendarId/events", () =>
    HttpResponse.json({
      id: "stub-event-id",
      htmlLink: "https://calendar.google.com/stub",
    }),
  ),
  // BlueBubbles
  http.post("http://localhost:1234/api/v1/message/text", () =>
    HttpResponse.json({ status: 200, message: "ok" }),
  ),
  // Telegram CDN (file fetch for voice notes)
  http.get("https://api.telegram.org/file/bot:token/:path*", () =>
    HttpResponse.arrayBuffer(new ArrayBuffer(8)),
  ),
];

export function setupMswServer(extraHandlers: RequestHandler[] = []) {
  const server = setupServer(...defaultHandlers, ...extraHandlers);

  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  return server;
}
