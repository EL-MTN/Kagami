import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCalendarClient } from "../src/ingest/calendar-client.js";
import { makeGmailClient } from "../src/ingest/gmail-client.js";
import {
  GOOGLE_REQUEST_TIMEOUT_MS,
  GoogleRequestTimeoutError,
} from "../src/ingest/google-timeout.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function installTimeoutMocks() {
  const controller = new AbortController();
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new DOMException("request timed out", "TimeoutError");
  });
  return { controller, fetchSpy, timeoutSpy };
}

describe("Google ingest clients — request timeout", () => {
  it("sets a 30s timeout signal on Gmail fetches and maps timeout failures", async () => {
    const { controller, fetchSpy, timeoutSpy } = installTimeoutMocks();
    const client = makeGmailClient(async () => "token");

    await expect(client.getProfile()).rejects.toMatchObject({
      code: "gmail_request_timeout",
      provider: "gmail",
    } satisfies Partial<GoogleRequestTimeoutError>);

    expect(timeoutSpy).toHaveBeenCalledWith(GOOGLE_REQUEST_TIMEOUT_MS);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://gmail.googleapis.com/gmail/v1/users/me/profile"),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("sets a 30s timeout signal on Calendar fetches and maps timeout failures", async () => {
    const { controller, fetchSpy, timeoutSpy } = installTimeoutMocks();
    const client = makeCalendarClient(async () => "token");

    await expect(client.listEvents({ timeMin: "2026-01-01T00:00:00.000Z" })).rejects.toMatchObject({
      code: "gcal_request_timeout",
      provider: "gcal",
    } satisfies Partial<GoogleRequestTimeoutError>);

    expect(timeoutSpy).toHaveBeenCalledWith(GOOGLE_REQUEST_TIMEOUT_MS);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://www.googleapis.com/calendar/v3/calendars/primary/events"),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
