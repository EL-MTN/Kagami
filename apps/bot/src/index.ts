import { config, logger, validateConfig } from "@mashiro/shared";

validateConfig();
import { connectDB, disconnectDB } from "@mashiro/db";
import { createBot, startBot, getAdapter } from "./platform/telegram/bot";
import { loadContext } from "./context/generator";
import { startProactiveScheduler } from "./scheduler/proactive";
import { startReminderScheduler } from "./scheduler/reminders";
import { startSkillScheduler } from "./scheduler/skills";
import { startWatcherScheduler } from "./scheduler/watchers";
import { shutdownBrowser } from "./services/browser";

// Bot-specific validation: TELEGRAM_BOT_TOKEN is required
function requireToken(): string {
  const token = config.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is required for the bot app");
    process.exit(1);
  }
  return token;
}
const TELEGRAM_BOT_TOKEN = requireToken();

let stopProactiveScheduler: (() => void) | null = null;
let stopReminderScheduler: (() => void) | null = null;
let stopSkillScheduler: (() => void) | null = null;
let stopWatcherScheduler: (() => void) | null = null;

async function main() {
  logger.info("Starting Mashiro...");

  await connectDB();

  await loadContext();

  const bot = createBot(TELEGRAM_BOT_TOKEN);

  startBot(bot);

  stopProactiveScheduler = startProactiveScheduler(getAdapter());
  stopReminderScheduler = startReminderScheduler(getAdapter());
  stopSkillScheduler = startSkillScheduler(getAdapter());
  stopWatcherScheduler = startWatcherScheduler(getAdapter());
}

function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down...`);
  stopProactiveScheduler?.();
  stopReminderScheduler?.();
  stopSkillScheduler?.();
  stopWatcherScheduler?.();
  void shutdownBrowser()
    .then(() => disconnectDB())
    .finally(() => process.exit(0));
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
