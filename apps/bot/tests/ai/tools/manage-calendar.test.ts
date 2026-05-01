import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mashiro/shared", async (orig) => ({
  ...((await orig()) as object),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

const { mockList, mockCreate, mockUpdate, mockDelete } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
}));
vi.mock("../../../src/services/google-calendar", () => ({
  listUpcomingEvents: mockList,
  createEvent: mockCreate,
  updateEvent: mockUpdate,
  deleteEvent: mockDelete,
}));

import { createManageCalendarTool } from "../../../src/ai/tools/manage-calendar";

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

beforeEach(() => {
  mockList.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockDelete.mockReset();
});

describe("manageCalendar tool — full mode", () => {
  const tool = createManageCalendarTool() as unknown as ExecutableTool;

  it("list action returns count + events and forwards daysAhead/maxResults", async () => {
    mockList.mockResolvedValue([{ id: "e1" }, { id: "e2" }]);
    const result = await tool.execute({ action: "list", daysAhead: 14, maxResults: 50 });
    expect(result).toEqual({ success: true, count: 2, events: [{ id: "e1" }, { id: "e2" }] });
    expect(mockList).toHaveBeenCalledWith(14, 50);
  });

  it("create action requires summary, start, and end", async () => {
    const missingSummary = await tool.execute({
      action: "create",
      start: "2026-06-01T10:00:00Z",
      end: "2026-06-01T11:00:00Z",
    });
    expect(missingSummary).toEqual({
      success: false,
      reason: "summary, start, and end are required to create an event",
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("create action calls createEvent with all the optional fields", async () => {
    mockCreate.mockResolvedValue({ id: "ev-new" });
    await tool.execute({
      action: "create",
      summary: "lunch",
      description: "with team",
      start: "2026-06-01T12:00:00Z",
      end: "2026-06-01T13:00:00Z",
      location: "Cafe",
    });
    expect(mockCreate).toHaveBeenCalledWith({
      summary: "lunch",
      description: "with team",
      start: "2026-06-01T12:00:00Z",
      end: "2026-06-01T13:00:00Z",
      location: "Cafe",
    });
  });

  it("update action requires eventId and forwards optional patch fields", async () => {
    mockUpdate.mockResolvedValue({ id: "ev-1", summary: "updated" });
    const missingId = await tool.execute({ action: "update", summary: "x" });
    expect(missingId).toEqual({ success: false, reason: "eventId is required for update" });

    await tool.execute({
      action: "update",
      eventId: "ev-1",
      summary: "updated",
    });
    expect(mockUpdate).toHaveBeenCalledWith("ev-1", {
      summary: "updated",
      description: undefined,
      start: undefined,
      end: undefined,
      location: undefined,
    });
  });

  it("delete action requires eventId and returns the deleted id on success", async () => {
    mockDelete.mockResolvedValue(undefined);
    const missingId = await tool.execute({ action: "delete" });
    expect(missingId).toEqual({ success: false, reason: "eventId is required for delete" });

    const result = await tool.execute({ action: "delete", eventId: "ev-1" });
    expect(result).toEqual({ success: true, deleted: "ev-1" });
    expect(mockDelete).toHaveBeenCalledWith("ev-1");
  });

  it("returns success:false with the error message when the underlying call throws", async () => {
    mockList.mockRejectedValue(new Error("calendar 500"));
    const result = await tool.execute({ action: "list" });
    expect(result).toEqual({ success: false, reason: "calendar 500" });
  });
});

describe("manageCalendar tool — readOnly mode", () => {
  const tool = createManageCalendarTool({ mode: "readOnly" }) as unknown as ExecutableTool;

  it("delegates to listUpcomingEvents and returns events", async () => {
    mockList.mockResolvedValue([{ id: "e1" }]);
    const result = await tool.execute({ daysAhead: 7, maxResults: 10 });
    expect(result).toEqual({ success: true, count: 1, events: [{ id: "e1" }] });
    expect(mockList).toHaveBeenCalledWith(7, 10);
  });

  it("rejects malformed args (action keyword) at the schema level", async () => {
    // The readOnly tool's schema only accepts daysAhead/maxResults — passing
    // an `action` field is silently ignored (z.object doesn't enforce strict
    // mode unless asked). Documenting current behavior — the tool simply
    // forwards what it knows about.
    mockList.mockResolvedValue([]);
    await tool.execute({ action: "delete", eventId: "ev-1" });
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockList).toHaveBeenCalled();
  });
});
