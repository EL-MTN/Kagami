import mongoose, { Schema, type Document } from "mongoose";

export interface IMediaAsset extends Document {
  filename: string;
  filePath: string;
  category: string;
  tags: string[];
  mood: string[];
  context: string[];
  telegramFileId?: string;
  useCount: number;
  lastUsed?: Date;
  createdAt: Date;
}

const mediaAssetSchema = new Schema<IMediaAsset>(
  {
    filename: { type: String, required: true, unique: true },
    filePath: { type: String, required: true },
    category: {
      type: String,
      required: true,
      enum: ["selfies", "outfits", "mood", "reactions"],
    },
    tags: [String],
    mood: [String],
    context: [String],
    telegramFileId: String,
    useCount: { type: Number, default: 0 },
    lastUsed: Date,
  },
  { timestamps: true },
);

mediaAssetSchema.index({ category: 1, mood: 1 });
mediaAssetSchema.index({ tags: 1 });
mediaAssetSchema.index({ useCount: 1 });

export const MediaAsset = mongoose.model<IMediaAsset>(
  "MediaAsset",
  mediaAssetSchema,
);
