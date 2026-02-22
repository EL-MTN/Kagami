import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { connectDB, disconnectDB } from "./db/connection.js";
import { createBot, startBot } from "./platform/telegram/bot.js";
import { loadReferenceImages } from "./media/generator.js";

async function main() {
  logger.info("Starting AIGF...");

  await connectDB();

  loadReferenceImages();

  const bot = createBot(config.TELEGRAM_BOT_TOKEN);

  await startBot(bot);
}

function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down...`);
  disconnectDB().finally(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  logger.fatal({ error }, "Uncaught exception");
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "Unhandled rejection");
});

main().catch((error) => {
  logger.fatal({ error }, "Unhandled error in main");
  process.exit(1);
});
