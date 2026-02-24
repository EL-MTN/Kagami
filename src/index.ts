import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { connectDB, disconnectDB } from "./db/connection.js";
import { createBot, startBot, getAdapter } from "./platform/telegram/bot.js";
import { loadContext } from "./context/generator.js";
import { startProactiveScheduler } from "./scheduler/proactive.js";

let stopProactiveScheduler: (() => void) | null = null;

async function main() {
  logger.info("Starting AIGF...");

  await connectDB();

  await loadContext();

  const bot = createBot(config.TELEGRAM_BOT_TOKEN);

  startBot(bot);

  stopProactiveScheduler = startProactiveScheduler(getAdapter());
}

function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down...`);
  stopProactiveScheduler?.();
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
  shutdown("unhandledRejection");
});

main().catch((error) => {
  logger.fatal({ error }, "Unhandled error in main");
  process.exit(1);
});
