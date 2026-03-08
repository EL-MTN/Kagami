import mongoose from "mongoose";
import { GridFSBucket } from "mongodb";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { logger } from "@mashiro/shared";

const BUCKET_NAME = "images";

function getBucket(): GridFSBucket {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB not connected — cannot access GridFS");
  return new GridFSBucket(db, { bucketName: BUCKET_NAME });
}

export function generateImageKey(): string {
  return randomUUID();
}

export async function writeImage(key: string, data: Buffer, mimeType: string): Promise<void> {
  const bucket = getBucket();
  const stream = bucket.openUploadStream(key, {
    metadata: { mimeType },
  });
  const readable = Readable.from(data);
  await new Promise<void>((resolve, reject) => {
    readable.pipe(stream).on("finish", resolve).on("error", reject);
  });
  logger.debug({ key, size: data.length, mimeType }, "Image written to GridFS");
}

export async function readImage(key: string): Promise<{ data: Buffer; mimeType: string } | null> {
  const bucket = getBucket();
  const files = await bucket.find({ filename: key }).toArray();
  if (files.length === 0) return null;

  const mimeType = (files[0].metadata?.mimeType as string) ?? "image/jpeg";
  const chunks: Buffer[] = [];
  const stream = bucket.openDownloadStreamByName(key);

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  return { data: Buffer.concat(chunks), mimeType };
}

export async function removeImage(key: string): Promise<void> {
  const bucket = getBucket();
  const files = await bucket.find({ filename: key }).toArray();
  for (const file of files) {
    await bucket.delete(file._id);
  }
}

export async function removeImages(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const bucket = getBucket();
  const files = await bucket.find({ filename: { $in: keys } }).toArray();
  for (const file of files) {
    await bucket.delete(file._id);
  }
  if (files.length > 0) {
    logger.debug({ count: files.length }, "Removed GridFS images");
  }
}
