import { MediaAsset, type IMediaAsset } from "../db/models/media-asset.js";
import type { PhotoQuery, SelectedPhoto } from "./types.js";
import { logger } from "../utils/logger.js";
import type { FilterQuery } from "mongoose";

export async function selectPhoto(
  query: PhotoQuery,
): Promise<SelectedPhoto | null> {
  const filter: FilterQuery<IMediaAsset> = {};

  if (query.category) {
    filter.category = query.category;
  }

  if (query.mood) {
    filter.$or = [
      { mood: { $regex: query.mood, $options: "i" } },
      { tags: { $regex: query.mood, $options: "i" } },
    ];
  }

  if (query.context) {
    const contextFilter = {
      $or: [
        { context: { $regex: query.context, $options: "i" } },
        { tags: { $regex: query.context, $options: "i" } },
      ],
    };
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, contextFilter];
      delete filter.$or;
    } else {
      Object.assign(filter, contextFilter);
    }
  }

  // Sort by least used, then random-ish (oldest lastUsed)
  let asset = await MediaAsset.findOne(filter).sort({
    useCount: 1,
    lastUsed: 1,
  });

  // Fallback: any photo in the category or any photo at all
  if (!asset && query.category) {
    asset = await MediaAsset.findOne({ category: query.category }).sort({
      useCount: 1,
    });
  }
  if (!asset) {
    asset = await MediaAsset.findOne().sort({ useCount: 1 });
  }

  if (!asset) {
    logger.debug({ query }, "No media assets found");
    return null;
  }

  // Track usage
  await MediaAsset.updateOne(
    { _id: asset._id },
    { $inc: { useCount: 1 }, lastUsed: new Date() },
  );

  return {
    id: String(asset._id),
    filePath: asset.filePath,
    telegramFileId: asset.telegramFileId,
    tags: asset.tags,
  };
}
