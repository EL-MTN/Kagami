/**
 * Memory System V2 Migration
 *
 * Run once before deploying behavior changes:
 * 1. Add sessionId and status to all existing conversations
 * 2. Import vault-only facts from about-you.md into Memory collection
 * 3. Import vault-only milestones from milestones.md into Memory collection
 * 4. Backfill metadata.updatedAt where missing
 *
 * Usage: npm run migrate:memory
 */

import dotenv from "dotenv";
dotenv.config({ path: "apps/bot/.env" });

import mongoose from "mongoose";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/mashiro";
const VAULT_PATH = process.env.VAULT_PATH ?? "./vault";

async function main() {
  console.log("=== Memory V2 Migration ===\n");

  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB\n");

  const db = mongoose.connection.db!;
  const conversations = db.collection("conversations");
  const memories = db.collection("memories");

  // 1. Add sessionId and status to existing conversations
  console.log("--- Step 1: Migrate conversations to session model ---");
  const convosWithoutSession = await conversations.countDocuments({
    sessionId: { $exists: false },
  });

  if (convosWithoutSession > 0) {
    const cursor = conversations.find({ sessionId: { $exists: false } });
    let updated = 0;
    for await (const doc of cursor) {
      await conversations.updateOne(
        { _id: doc._id },
        {
          $set: {
            sessionId: crypto.randomUUID(),
            status: "closed",
            closedAt: doc.updatedAt ?? doc.createdAt ?? new Date(),
          },
        },
      );
      updated++;
    }
    console.log(`  Updated ${updated} conversations with sessionId + closed status`);
  } else {
    console.log("  No conversations need migration (already have sessionId)");
  }

  // 2. Import vault facts into Memory collection
  console.log("\n--- Step 2: Import vault facts ---");
  const aboutYouPath = path.resolve(VAULT_PATH, "memories/about-you.md");
  try {
    const raw = await fs.readFile(aboutYouPath, "utf-8");
    const { content } = matter(raw);
    const lines = content
      .split("\n")
      .map((l) => l.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean);

    // Get existing fact contents for dedup
    const existingFacts = await memories.find({ type: "fact" }).toArray();
    const existingContents = new Set(existingFacts.map((f) => f.content.toLowerCase().trim()));

    let imported = 0;
    let skipped = 0;
    for (const line of lines) {
      if (existingContents.has(line.toLowerCase().trim())) {
        skipped++;
        continue;
      }
      await memories.insertOne({
        content: line,
        type: "fact",
        source: "vault-migration",
        embedding: [], // Will need re-embedding if semantic search is needed
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      imported++;
    }
    console.log(
      `  Found ${lines.length} facts in vault: ${imported} imported, ${skipped} already exist`,
    );
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("  about-you.md not found, skipping");
    } else {
      throw err;
    }
  }

  // 3. Import vault milestones into Memory collection
  console.log("\n--- Step 3: Import vault milestones ---");
  const milestonesPath = path.resolve(VAULT_PATH, "memories/milestones.md");
  try {
    const raw = await fs.readFile(milestonesPath, "utf-8");
    const { content } = matter(raw);
    const lines = content
      .split("\n")
      .map((l) => l.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean);

    const existingMilestones = await memories.find({ type: "milestone" }).toArray();
    const existingContents = new Set(existingMilestones.map((m) => m.content.toLowerCase().trim()));

    let imported = 0;
    let skipped = 0;
    for (const line of lines) {
      if (existingContents.has(line.toLowerCase().trim())) {
        skipped++;
        continue;
      }
      await memories.insertOne({
        content: line,
        type: "milestone",
        source: "vault-migration",
        embedding: [],
        metadata: {
          importance: 7,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      imported++;
    }
    console.log(
      `  Found ${lines.length} milestones in vault: ${imported} imported, ${skipped} already exist`,
    );
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("  milestones.md not found, skipping");
    } else {
      throw err;
    }
  }

  // 4. Backfill metadata.updatedAt where missing
  console.log("\n--- Step 4: Backfill metadata.updatedAt ---");
  const missingUpdatedAt = await memories.countDocuments({
    "metadata.updatedAt": { $exists: false },
  });

  if (missingUpdatedAt > 0) {
    const cursor = memories.find({ "metadata.updatedAt": { $exists: false } });
    let fixed = 0;
    for await (const doc of cursor) {
      await memories.updateOne(
        { _id: doc._id },
        { $set: { "metadata.updatedAt": doc.metadata?.createdAt ?? new Date() } },
      );
      fixed++;
    }
    console.log(`  Backfilled updatedAt on ${fixed} memories`);
  } else {
    console.log("  All memories already have updatedAt");
  }

  // Summary
  const totalConvos = await conversations.countDocuments();
  const totalMemories = await memories.countDocuments();
  const factCount = await memories.countDocuments({ type: "fact" });
  const episodeCount = await memories.countDocuments({ type: "episode" });
  const milestoneCount = await memories.countDocuments({ type: "milestone" });

  console.log("\n=== Migration Complete ===");
  console.log(`  Conversations: ${totalConvos}`);
  console.log(
    `  Memories: ${totalMemories} (${factCount} facts, ${episodeCount} episodes, ${milestoneCount} milestones)`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
