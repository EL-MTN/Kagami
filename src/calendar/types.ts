export interface CalendarEvent {
  date: string;
  title: string;
  notes?: string;
  source: "vault" | "db";
}

export interface CalendarQuery {
  query?: string;
  startDate?: string;
  endDate?: string;
}
