import mongoose, { Schema, type Document } from "mongoose";

export interface IReminder extends Document {
  chatId: string;
  message: string;
  fireAt: Date;
  createdAt: Date;
  fired: boolean;
}

const reminderSchema = new Schema<IReminder>(
  {
    chatId: { type: String, required: true },
    message: { type: String, required: true },
    fireAt: { type: Date, required: true },
    fired: { type: Boolean, default: false },
  },
  { timestamps: true },
);

reminderSchema.index({ fired: 1, fireAt: 1 });

export const Reminder = mongoose.model<IReminder>("Reminder", reminderSchema);

export async function createReminder(
  chatId: string,
  message: string,
  fireAt: Date,
): Promise<IReminder> {
  return Reminder.create({ chatId, message, fireAt });
}

export async function getPendingReminders(): Promise<IReminder[]> {
  return Reminder.find({ fired: false, fireAt: { $lte: new Date() } }).sort({ fireAt: 1 });
}

export async function markReminderFired(reminderId: string): Promise<void> {
  await Reminder.findByIdAndUpdate(reminderId, { fired: true });
}

export async function listRemindersForChat(chatId: string): Promise<IReminder[]> {
  return Reminder.find({ chatId, fired: false }).sort({ fireAt: 1 });
}

export async function deleteReminder(reminderId: string): Promise<boolean> {
  const result = await Reminder.findByIdAndDelete(reminderId);
  return result !== null;
}
