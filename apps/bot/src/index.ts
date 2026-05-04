import { config, logger, validateConfig } from "@kokoro/shared";

validateConfig();
import { connectDB, disconnectDB } from "@kokoro/db";
import { createBot, startBot, getAdapter } from "./platform/telegram/bot";
import { BlueBubblesClient } from "./platform/imessage/client";
import { BlueBubblesAdapter } from "./platform/imessage/adapter";
import { startBlueBubblesWebhook } from "./platform/imessage/webhook";
import { AdapterRegistry } from "./platform/registry";
import { loadContext } from "./context/generator";
import { startProactiveScheduler } from "./scheduler/proactive";
import { startReminderScheduler } from "./scheduler/reminders";
import { startRoutineScheduler } from "./scheduler/routines";
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
let stopRoutineScheduler: (() => void) | null = null;
let stopWatcherScheduler: (() => void) | null = null;
let stopBlueBubblesWebhook: (() => void) | null = null;

async function main() {
  logger.info("Starting Kokoro...");

  await connectDB();

  await loadContext();

  const registry = new AdapterRegistry();

  const bot = createBot(TELEGRAM_BOT_TOKEN);
  startBot(bot);
  registry.register(getAdapter());

  // BlueBubbles is opt-in via env. When configured, register the adapter
  // and start the webhook listener so iMessage events route through the
  // same handleMessage pipeline as Telegram.
  if (config.BLUEBUBBLES_HOST && config.BLUEBUBBLES_PASSWORD) {
    const client = new BlueBubblesClient({
      host: config.BLUEBUBBLES_HOST,
      password: config.BLUEBUBBLES_PASSWORD,
    });
    const bbAdapter = new BlueBubblesAdapter(client);
    registry.register(bbAdapter);
    stopBlueBubblesWebhook = startBlueBubblesWebhook({
      port: config.BLUEBUBBLES_WEBHOOK_PORT,
      password: config.BLUEBUBBLES_PASSWORD,
      adapter: bbAdapter,
    });
  } else if (config.ALLOWED_IMESSAGE_HANDLES.length > 0) {
    logger.warn(
      "ALLOWED_IMESSAGE_HANDLES set but BLUEBUBBLES_HOST/PASSWORD missing; iMessage disabled",
    );
  }

  stopProactiveScheduler = startProactiveScheduler(registry);
  stopReminderScheduler = startReminderScheduler(registry);
  stopRoutineScheduler = startRoutineScheduler(registry);
  stopWatcherScheduler = startWatcherScheduler(registry);
}

function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down...`);
  stopProactiveScheduler?.();
  stopReminderScheduler?.();
  stopRoutineScheduler?.();
  stopWatcherScheduler?.();
  stopBlueBubblesWebhook?.();
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
