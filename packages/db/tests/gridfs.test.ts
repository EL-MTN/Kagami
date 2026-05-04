import { withTestDb } from "@kokoro/test-utils";
import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import {
  generateAudioKey,
  generateImageKey,
  readAudio,
  readImage,
  removeAudio,
  removeImage,
  removeImages,
  writeAudio,
  writeImage,
} from "../src/gridfs";

withTestDb({ syncIndexes: false });

async function listBucketFilenames(bucketName: string): Promise<string[]> {
  const db = mongoose.connection.db!;
  const bucket = new mongoose.mongo.GridFSBucket(db, { bucketName });
  const files = await bucket.find({}).toArray();
  return files.map((f) => f.filename);
}

describe("generateImageKey / generateAudioKey", () => {
  it("returns valid UUID strings", () => {
    expect(generateImageKey()).toMatch(/^[0-9a-f-]{36}$/);
    expect(generateAudioKey()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns distinct keys on each call", () => {
    expect(generateImageKey()).not.toBe(generateImageKey());
    expect(generateAudioKey()).not.toBe(generateAudioKey());
  });
});

describe("image bucket roundtrip", () => {
  it("write then read returns identical bytes and mimeType", async () => {
    const key = generateImageKey();
    const original = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    await writeImage(key, original, "image/jpeg");

    const result = await readImage(key);
    expect(result).not.toBeNull();
    expect(Buffer.compare(result!.data, original)).toBe(0);
    expect(result!.mimeType).toBe("image/jpeg");
  });

  it("readImage returns null for an unknown key", async () => {
    expect(await readImage("missing-key")).toBeNull();
  });

  it("falls back to image/jpeg when metadata.mimeType is absent", async () => {
    const db = mongoose.connection.db!;
    const bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: "images" });
    const key = "no-meta";
    await new Promise<void>((resolve, reject) => {
      const stream = bucket.openUploadStream(key);
      stream.on("finish", resolve).on("error", reject);
      stream.end(Buffer.from("hi"));
    });
    const result = await readImage(key);
    expect(result?.mimeType).toBe("image/jpeg");
  });
});

describe("audio bucket roundtrip", () => {
  it("write then read returns identical bytes and mimeType", async () => {
    const key = generateAudioKey();
    const original = Buffer.from("OggS\x00\x02\x00\x00", "binary");
    await writeAudio(key, original, "audio/ogg");

    const result = await readAudio(key);
    expect(result).not.toBeNull();
    expect(Buffer.compare(result!.data, original)).toBe(0);
    expect(result!.mimeType).toBe("audio/ogg");
  });

  it("readAudio returns null for an unknown key", async () => {
    expect(await readAudio("missing-key")).toBeNull();
  });

  it("audio bucket falls back to audio/ogg when metadata.mimeType is absent", async () => {
    const db = mongoose.connection.db!;
    const bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: "audio" });
    const key = "no-meta";
    await new Promise<void>((resolve, reject) => {
      const stream = bucket.openUploadStream(key);
      stream.on("finish", resolve).on("error", reject);
      stream.end(Buffer.from("hi"));
    });
    const result = await readAudio(key);
    expect(result?.mimeType).toBe("audio/ogg");
  });
});

describe("bucket isolation", () => {
  it("an image written to the image bucket is NOT visible in the audio bucket and vice versa", async () => {
    const imgKey = generateImageKey();
    const audKey = generateAudioKey();
    await writeImage(imgKey, Buffer.from("img"), "image/png");
    await writeAudio(audKey, Buffer.from("aud"), "audio/m4a");

    expect(await readImage(audKey)).toBeNull();
    expect(await readAudio(imgKey)).toBeNull();

    // Roundtrip in their own buckets still works.
    expect((await readImage(imgKey))?.data.toString()).toBe("img");
    expect((await readAudio(audKey))?.data.toString()).toBe("aud");

    // Bucket file listings are disjoint.
    const imageFiles = await listBucketFilenames("images");
    const audioFiles = await listBucketFilenames("audio");
    expect(imageFiles).toContain(imgKey);
    expect(imageFiles).not.toContain(audKey);
    expect(audioFiles).toContain(audKey);
    expect(audioFiles).not.toContain(imgKey);
  });
});

describe("removeImage / removeAudio (single)", () => {
  it("removeImage deletes the image and leaves audio untouched", async () => {
    const imgKey = generateImageKey();
    const audKey = generateAudioKey();
    await writeImage(imgKey, Buffer.from("i"), "image/png");
    await writeAudio(audKey, Buffer.from("a"), "audio/m4a");

    await removeImage(imgKey);

    expect(await readImage(imgKey)).toBeNull();
    expect(await readAudio(audKey)).not.toBeNull();
  });

  it("removeAudio is symmetric", async () => {
    const imgKey = generateImageKey();
    const audKey = generateAudioKey();
    await writeImage(imgKey, Buffer.from("i"), "image/png");
    await writeAudio(audKey, Buffer.from("a"), "audio/m4a");

    await removeAudio(audKey);

    expect(await readImage(imgKey)).not.toBeNull();
    expect(await readAudio(audKey)).toBeNull();
  });

  it("removeImage on a missing key is a no-op", async () => {
    await expect(removeImage("does-not-exist")).resolves.toBeUndefined();
  });
});

describe("removeImages / removeAudios (batch)", () => {
  it("removes all listed image keys without touching the audio bucket", async () => {
    const k1 = generateImageKey();
    const k2 = generateImageKey();
    const k3 = generateImageKey();
    const aud = generateAudioKey();
    await writeImage(k1, Buffer.from("1"), "image/png");
    await writeImage(k2, Buffer.from("2"), "image/png");
    await writeImage(k3, Buffer.from("3"), "image/png");
    await writeAudio(aud, Buffer.from("a"), "audio/m4a");

    await removeImages([k1, k3]);

    expect(await readImage(k1)).toBeNull();
    expect(await readImage(k2)).not.toBeNull();
    expect(await readImage(k3)).toBeNull();
    expect(await readAudio(aud)).not.toBeNull();
  });

  it("removeImages on an empty list is a no-op", async () => {
    const k = generateImageKey();
    await writeImage(k, Buffer.from("i"), "image/png");
    await removeImages([]);
    expect(await readImage(k)).not.toBeNull();
  });

  it("removeImages tolerates a list containing unknown keys", async () => {
    const k = generateImageKey();
    await writeImage(k, Buffer.from("i"), "image/png");
    await removeImages([k, "does-not-exist"]);
    expect(await readImage(k)).toBeNull();
  });
});
