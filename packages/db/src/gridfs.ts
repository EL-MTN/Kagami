import mongoose, { mongo } from "mongoose";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { logger } from "@mashiro/shared";

const IMAGE_BUCKET = "images";
const AUDIO_BUCKET = "audio";

function getBucket(name: string): mongo.GridFSBucket {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB not connected — cannot access GridFS");
  return new mongo.GridFSBucket(db, { bucketName: name });
}

async function writeBlob(
  bucketName: string,
  key: string,
  data: Buffer,
  mimeType: string,
): Promise<void> {
  const bucket = getBucket(bucketName);
  const stream = bucket.openUploadStream(key, { metadata: { mimeType } });
  const readable = Readable.from(data);
  await new Promise<void>((resolve, reject) => {
    readable.pipe(stream).on("finish", resolve).on("error", reject);
  });
  logger.debug({ bucket: bucketName, key, size: data.length, mimeType }, "Blob written to GridFS");
}

async function readBlob(
  bucketName: string,
  key: string,
  defaultMimeType: string,
): Promise<{ data: Buffer; mimeType: string } | null> {
  const bucket = getBucket(bucketName);
  const files = await bucket.find({ filename: key }).toArray();
  if (files.length === 0) return null;

  const mimeType = (files[0].metadata?.mimeType as string) ?? defaultMimeType;
  const chunks: Buffer[] = [];
  const stream = bucket.openDownloadStreamByName(key);

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  return { data: Buffer.concat(chunks), mimeType };
}

async function removeBlob(bucketName: string, key: string): Promise<void> {
  const bucket = getBucket(bucketName);
  const files = await bucket.find({ filename: key }).toArray();
  for (const file of files) {
    await bucket.delete(file._id);
  }
}

async function removeBlobs(bucketName: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const bucket = getBucket(bucketName);
  const files = await bucket.find({ filename: { $in: keys } }).toArray();
  for (const file of files) {
    await bucket.delete(file._id);
  }
  if (files.length > 0) {
    logger.debug({ bucket: bucketName, count: files.length }, "Removed GridFS blobs");
  }
}

// Image bucket — original public API kept stable.

export function generateImageKey(): string {
  return randomUUID();
}

export async function writeImage(key: string, data: Buffer, mimeType: string): Promise<void> {
  await writeBlob(IMAGE_BUCKET, key, data, mimeType);
}

export async function readImage(key: string): Promise<{ data: Buffer; mimeType: string } | null> {
  return readBlob(IMAGE_BUCKET, key, "image/jpeg");
}

export async function removeImage(key: string): Promise<void> {
  await removeBlob(IMAGE_BUCKET, key);
}

export async function removeImages(keys: string[]): Promise<void> {
  await removeBlobs(IMAGE_BUCKET, keys);
}

// Audio bucket — separate GridFS collection (`audio.files`, `audio.chunks`).
// Used for inbound voice notes from Telegram and iMessage. The original audio
// is persisted alongside the transcript so a future multimodal model can be
// re-fed the audio without a re-record.

export function generateAudioKey(): string {
  return randomUUID();
}

export async function writeAudio(key: string, data: Buffer, mimeType: string): Promise<void> {
  await writeBlob(AUDIO_BUCKET, key, data, mimeType);
}

export async function readAudio(key: string): Promise<{ data: Buffer; mimeType: string } | null> {
  return readBlob(AUDIO_BUCKET, key, "audio/ogg");
}

export async function removeAudio(key: string): Promise<void> {
  await removeBlob(AUDIO_BUCKET, key);
}

export async function removeAudios(keys: string[]): Promise<void> {
  await removeBlobs(AUDIO_BUCKET, keys);
}
