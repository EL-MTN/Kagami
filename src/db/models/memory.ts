import mongoose, { Schema, type Document } from "mongoose";

export interface IMemoryMetadata {
  chatId?: string;
  emotionalTone?: number;
  importance?: number;
  followUps?: string[];
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date;
  mergedInto?: string;
  sessionId?: string;
  expiresAt?: Date;
}

export interface IMemory extends Document {
  content: string;
  type: "fact" | "episode" | "milestone" | "working";
  source: string;
  embedding: number[];
  metadata: IMemoryMetadata;
}

const memorySchema = new Schema<IMemory>(
  {
    content: { type: String, required: true },
    type: { type: String, enum: ["fact", "episode", "milestone", "working"], required: true },
    source: { type: String, required: true },
    embedding: { type: [Number], required: true },
    metadata: {
      chatId: { type: String },
      emotionalTone: { type: Number },
      importance: { type: Number },
      followUps: { type: [String] },
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date, default: Date.now },
      archivedAt: { type: Date },
      mergedInto: { type: String },
      sessionId: { type: String },
      expiresAt: { type: Date },
    },
  },
  { timestamps: false },
);

memorySchema.index({ type: 1 });
memorySchema.index({ "metadata.chatId": 1 });
memorySchema.index({ "metadata.createdAt": -1 });
memorySchema.index({ type: 1, "metadata.archivedAt": 1 });
memorySchema.index({ type: 1, source: 1, "metadata.createdAt": -1 });
memorySchema.index({ "metadata.expiresAt": 1 }, { expireAfterSeconds: 0 });

export const Memory = mongoose.model<IMemory>("Memory", memorySchema);
