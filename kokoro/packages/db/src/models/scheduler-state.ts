import mongoose, { Schema, type Document } from "mongoose";

export interface ISchedulerState extends Document {
  id: string;
  chatId: string;
  nextProactiveAt: Date;
}

const schedulerStateSchema = new Schema<ISchedulerState>(
  {
    chatId: { type: String, required: true, unique: true },
    nextProactiveAt: { type: Date, required: true },
  },
  { timestamps: true },
);

export const SchedulerState =
  (mongoose.models.SchedulerState as mongoose.Model<ISchedulerState>) ??
  mongoose.model<ISchedulerState>("SchedulerState", schedulerStateSchema);

export async function getNextProactiveAt(chatId: string): Promise<Date | null> {
  const state = await SchedulerState.findOne({ chatId });
  return state?.nextProactiveAt ?? null;
}

export async function setNextProactiveAt(chatId: string, nextAt: Date): Promise<void> {
  await SchedulerState.updateOne({ chatId }, { nextProactiveAt: nextAt }, { upsert: true });
}
