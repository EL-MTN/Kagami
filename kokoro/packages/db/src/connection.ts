import mongoose from "mongoose";
import { config, logger } from "@kokoro/shared";

export async function connectDB(): Promise<void> {
  try {
    await mongoose.connect(config.MONGODB_URI);
    logger.info("Connected to MongoDB");
  } catch (error) {
    logger.fatal({ error: error }, "Failed to connect to MongoDB");
    process.exit(1);
  }
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
  logger.info("Disconnected from MongoDB");
}

export function isDuplicateKeyError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as Record<string, unknown>).code === 11000
  );
}
