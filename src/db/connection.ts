import mongoose from "mongoose";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export async function connectDB(): Promise<void> {
  try {
    await mongoose.connect(config.MONGODB_URI);
    logger.info("Connected to MongoDB");
  } catch (error) {
    logger.fatal({ error }, "Failed to connect to MongoDB");
    process.exit(1);
  }
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
  logger.info("Disconnected from MongoDB");
}
