import mongoose, { Schema, type Document } from "mongoose";
import { haversineMeters } from "@mashiro/shared";

export interface ILocationHistory extends Document {
  chatId: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  heading?: number;
  placeName?: string;
  placeCategory?: string;
  isLive: boolean;
  timestamp: Date;
}

const locationHistorySchema = new Schema<ILocationHistory>({
  chatId: { type: String, required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  accuracy: { type: Number },
  heading: { type: Number },
  placeName: { type: String },
  placeCategory: { type: String },
  isLive: { type: Boolean, default: false },
  timestamp: { type: Date, required: true, default: Date.now },
});

locationHistorySchema.index({ chatId: 1, timestamp: -1 });
locationHistorySchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const LocationHistory =
  (mongoose.models.LocationHistory as mongoose.Model<ILocationHistory>) ??
  mongoose.model<ILocationHistory>("LocationHistory", locationHistorySchema);

export async function storeLocation(
  chatId: string,
  latitude: number,
  longitude: number,
  options: {
    accuracy?: number;
    heading?: number;
    placeName?: string;
    placeCategory?: string;
    isLive?: boolean;
  } = {},
): Promise<ILocationHistory> {
  return LocationHistory.create({
    chatId,
    latitude,
    longitude,
    accuracy: options.accuracy,
    heading: options.heading,
    placeName: options.placeName,
    placeCategory: options.placeCategory,
    isLive: options.isLive ?? false,
    timestamp: new Date(),
  });
}

export async function getLatestLocation(chatId: string): Promise<ILocationHistory | null> {
  return LocationHistory.findOne({ chatId }).sort({ timestamp: -1 });
}

export async function getRecentLocations(
  chatId: string,
  limit = 10,
  maxAgeHours = 24,
): Promise<ILocationHistory[]> {
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
  return LocationHistory.find({ chatId, timestamp: { $gte: cutoff } })
    .sort({ timestamp: -1 })
    .limit(limit);
}

export async function getLocationVisitCount(
  chatId: string,
  latitude: number,
  longitude: number,
  radiusM = 200,
  withinDays = 30,
): Promise<number> {
  const cutoff = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000);
  const all = await LocationHistory.find({
    chatId,
    timestamp: { $gte: cutoff },
  });

  // Filter by haversine distance
  let count = 0;
  for (const loc of all) {
    if (haversineMeters(latitude, longitude, loc.latitude, loc.longitude) <= radiusM) {
      count++;
    }
  }
  return count;
}

export async function cleanupOldLocations(olderThanDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await LocationHistory.deleteMany({
    timestamp: { $lt: cutoff },
  });
  return result.deletedCount;
}
