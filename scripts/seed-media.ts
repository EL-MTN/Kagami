import "dotenv/config";
import mongoose from "mongoose";
import fs from "node:fs/promises";
import path from "node:path";

const MEDIA_PATH = "./media";
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/aigf";

// Schema inline to avoid import issues with config
const mediaAssetSchema = new mongoose.Schema({
  filename: { type: String, required: true, unique: true },
  filePath: { type: String, required: true },
  category: { type: String, required: true },
  tags: [String],
  mood: [String],
  context: [String],
  telegramFileId: String,
  useCount: { type: Number, default: 0 },
  lastUsed: Date,
}, { timestamps: true });

const MediaAsset = mongoose.model("MediaAsset", mediaAssetSchema);

const CATEGORIES = ["selfies", "outfits", "mood", "reactions"];
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

async function seed() {
  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB");

  let total = 0;

  for (const category of CATEGORIES) {
    const dirPath = path.join(MEDIA_PATH, category);
    let files: string[];
    try {
      files = await fs.readdir(dirPath);
    } catch {
      console.log(`Skipping ${category}/ (not found)`);
      continue;
    }

    const imageFiles = files.filter((f) =>
      IMAGE_EXTENSIONS.includes(path.extname(f).toLowerCase()),
    );

    for (const file of imageFiles) {
      const filePath = path.join(dirPath, file);
      const nameWithoutExt = path.parse(file).name;
      // Derive tags from filename: "happy-gym-selfie.jpg" → ["happy", "gym", "selfie"]
      const tags = nameWithoutExt.split(/[-_ ]+/);

      await MediaAsset.updateOne(
        { filename: file },
        {
          $setOnInsert: {
            filename: file,
            filePath,
            category,
            tags,
            mood: tags.filter((t) =>
              ["happy", "sad", "cozy", "flirty", "sleepy", "excited", "chill", "playful"].includes(t),
            ),
            context: tags.filter(
              (t) => !["happy", "sad", "cozy", "flirty", "sleepy", "excited", "chill", "playful"].includes(t),
            ),
            useCount: 0,
          },
        },
        { upsert: true },
      );
      total++;
    }

    console.log(`Seeded ${imageFiles.length} assets from ${category}/`);
  }

  console.log(`Total: ${total} media assets`);
  await mongoose.disconnect();
}

seed().catch(console.error);
