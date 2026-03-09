import { Stagehand } from "@browserbasehq/stagehand";
import { config, logger } from "@mashiro/shared";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

let instance: Stagehand | null = null;
let initPromise: Promise<Stagehand> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let lockChain: Promise<void> = Promise.resolve();

/**
 * Serialize access to the browser. Parallel tool calls from the same LLM step
 * share one page — concurrent goto() calls cancel each other. This lock ensures
 * only one browse action navigates at a time.
 */
export function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = lockChain;
  lockChain = next;
  return prev.then(fn).finally(() => release!());
}

function ensureDirs(): { cacheDir: string; profileDir: string } {
  const base = resolve(config.BROWSER_DATA_DIR);
  const cacheDir = resolve(base, "cache");
  const profileDir = resolve(base, "chromium-profile");
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  return { cacheDir, profileDir };
}

/**
 * Maps the configured LLM provider to Stagehand's "provider/model" format.
 * Uses BROWSER_MODEL if set, otherwise defaults to the Fast tier for the active provider.
 * Stagehand reads API keys from env (ANTHROPIC_API_KEY, OPENAI_API_KEY) automatically —
 * only xAI needs explicit baseURL/apiKey since Stagehand doesn't support it natively.
 */
export function getStagehandModelConfig():
  | string
  | { modelName: string; apiKey: string; baseURL: string } {
  // Explicit override — return as-is (Stagehand reads API keys from env)
  if (config.BROWSER_MODEL) return config.BROWSER_MODEL;

  const provider = config.LLM_PROVIDER;

  if (provider === "xai") {
    return {
      modelName: "openai/grok-4-1-fast-non-reasoning",
      apiKey: config.XAI_API_KEY!,
      baseURL: "https://api.x.ai/v1",
    };
  }

  const models: Record<string, string> = {
    anthropic: "anthropic/claude-haiku-4-5",
    openai: "openai/gpt-4o-mini",
  };

  return models[provider] ?? "anthropic/claude-haiku-4-5";
}

async function createInstance(): Promise<Stagehand> {
  const { cacheDir, profileDir } = ensureDirs();
  const modelConfig = getStagehandModelConfig();

  const stagehand = new Stagehand({
    env: "LOCAL",
    model: modelConfig,
    selfHeal: true,
    cacheDir,
    disablePino: true,
    verbose: 0,
    localBrowserLaunchOptions: {
      headless: config.BROWSER_HEADLESS,
      userDataDir: profileDir,
    },
  });

  await stagehand.init();
  logger.info("Browser initialized");
  return stagehand;
}

/**
 * Lazy-init the browser singleton. Clears idle timer on acquire.
 * Concurrent callers share the same init promise (mutex).
 */
export async function acquireBrowser(): Promise<Stagehand> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  if (instance) return instance;

  if (!initPromise) {
    initPromise = createInstance()
      .then((s) => {
        instance = s;
        initPromise = null;
        return s;
      })
      .catch((err) => {
        initPromise = null;
        throw err;
      });
  }

  return initPromise;
}

/**
 * Start a 5-minute idle shutdown timer after the tool call completes.
 */
export function releaseBrowser(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void shutdownBrowser();
  }, IDLE_TIMEOUT_MS);
}

/**
 * Graceful close for process shutdown.
 */
export async function shutdownBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  const current = instance;
  instance = null;
  initPromise = null;

  if (current) {
    try {
      await current.close();
      logger.info("Browser shut down");
    } catch (err) {
      logger.warn({ err }, "Error closing browser");
    }
  }
}

/**
 * Reset singleton on browser crash (Target closed errors).
 * Next acquireBrowser() call will re-init.
 */
export function resetBrowser(): void {
  instance = null;
  initPromise = null;
}
