import mongoose, { Schema, type Document } from "mongoose";

export interface ICalendarEvent extends Document {
  date: Date;
  title: string;
  notes?: string;
  recurring: boolean;
  recurrenceRule?: string;
  createdAt: Date;
}

const calendarEventSchema = new Schema<ICalendarEvent>(
  {
    date: { type: Date, required: true, index: true },
    title: { type: String, required: true },
    notes: String,
    recurring: { type: Boolean, default: false },
    recurrenceRule: String,
  },
  { timestamps: true },
);

export const CalendarEvent = mongoose.model<ICalendarEvent>(
  "CalendarEvent",
  calendarEventSchema,
);
