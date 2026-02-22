import mongoose, { Schema, type Document } from "mongoose";

export interface IMediaAsset extends Document {
  promptHash: string;
  prompt: string;
  imageData?: string;
  mimeType?: string;
  telegramFileId?: string;
  generatedAt: Date;
}

const mediaAssetSchema = new Schema<IMediaAsset>({
  promptHash: { type: String, required: true, unique: true },
  prompt: { type: String, required: true },
  imageData: String,
  mimeType: String,
  telegramFileId: String,
  generatedAt: { type: Date, default: Date.now },
});

mediaAssetSchema.index({ promptHash: 1 });

export const MediaAsset = mongoose.model<IMediaAsset>("MediaAsset", mediaAssetSchema);
