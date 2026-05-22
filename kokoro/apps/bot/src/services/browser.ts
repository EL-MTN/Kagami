import { Stagehand, type LogLine } from "@browserbasehq/stagehand";
import { config, logger, runWithSpan } from "@kokoro/shared";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const isCloud = config.BROWSER_ENV === "cloud";
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_ACTION_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes — circuit breaker, not an SLO

// --- Stagehand → Kansoku observability bridge ---
//
// Stagehand's own steps (act/observe/extract/agent inference, DOM work) are
// invisible by default (`verbose: 0, disablePino: true`). We route its
// internal logger into `@kokoro/shared`'s logger instead, so every browser
// step ships to Kansoku correlated with the active trace/span (the pino mixin
// stamps trace.id/span.id from AsyncLocalStorage at log time, and the browse
// action runs inside a `runWithSpan`). The prompts/responses/DOM live in
// `auxiliary`; each value is capped so a full-page DOM dump can't bloat ingest.
const AUX_VALUE_CAP = 4000;

// verbose 2 (full prompts/DOM) only when debugging; verbose 1 (step-level)
// otherwise. Stagehand levels: 0 = error/warn, 1 = info, 2 = debug.
const STAGEHAND_VERBOSE: 0 | 1 | 2 =
  config.LOG_LEVEL === "debug" || config.LOG_LEVEL === "trace" ? 2 : 1;

function stagehandLogger(line: LogLine): void {
  const aux: Record<string, string> = {};
  if (line.auxiliary) {
    for (const [key, entry] of Object.entries(line.auxiliary)) {
      aux[key] =
        entry.value.length > AUX_VALUE_CAP
          ? `${entry.value.slice(0, AUX_VALUE_CAP)}…[truncated ${entry.value.length - AUX_VALUE_CAP}]`
          : entry.value;
    }
  }
  const fields = { browser: { category: line.category ?? "stagehand", ...aux } };
  const message = `browser: ${line.message}`;
  switch (line.level) {
    case 0:
      logger.warn(fields, message);
      break;
    case 2:
      logger.debug(fields, message);
      break;
    default: // 1 or undefined
      logger.info(fields, message);
  }
}

interface BrowserLockOptions {
  /** Wall-clock cap for the inner fn. Defaults to 2 minutes; agent flows pass longer. */
  timeoutMs?: number;
  /** Label included in the timeout error message for log triage. */
  label?: string;
}

let instance: Stagehand | null = null;
let initPromise: Promise<Stagehand> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let lockChain: Promise<void> = Promise.resolve();

function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string | undefined,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const tag = label ? ` (${label})` : "";
      reject(new Error(`Browser action timed out after ${timeoutMs}ms${tag}`));
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Serialize access to the browser. Parallel tool calls from the same LLM step
 * share one page — concurrent goto() calls cancel each other. This lock ensures
 * only one browse action navigates at a time.
 *
 * `timeoutMs` is a wall-clock circuit breaker so a wedged page can't pin the
 * lock indefinitely. When the timeout fires we tear the browser down here —
 * the inner fn() is still running but unobservable, so its own catch can't
 * reset the singleton. The next caller acquires a fresh instance.
 */
export function withBrowserLock<T>(
  fn: () => Promise<T>,
  options: BrowserLockOptions = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_ACTION_TIMEOUT_MS, label } = options;
  let release: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = lockChain;
  lockChain = next;
  return prev
    .then(() => raceWithTimeout(fn(), timeoutMs, label))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("timed out")) {
        // Synchronous part of shutdownBrowser nulls `instance` immediately so
        // the next acquireBrowser re-inits; the async close fires in the
        // background to actually release the wedged Chromium process.
        void shutdownBrowser();
      }
      throw error;
    })
    .finally(() => release!());
}

// --- Directory helpers ---

function ensureDirs(): { cacheDir: string; profileDir: string } {
  const base = resolve(config.BROWSER_DATA_DIR);
  const cacheDir = resolve(base, "cache");
  const profileDir = resolve(base, "chromium-profile");
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  return { cacheDir, profileDir };
}

// --- Geolocation ---

function parseGeolocation(): { latitude: number; longitude: number } | undefined {
  const geo = config.BROWSER_GEOLOCATION;
  if (!geo) return undefined;
  const [lat, lng] = geo.split(",").map(Number);
  if (isNaN(lat) || isNaN(lng)) return undefined;
  return { latitude: lat, longitude: lng };
}

// --- Model config ---

/**
 * Maps the configured LLM provider to Stagehand's "provider/model" format.
 * Uses BROWSER_MODEL if set, otherwise defaults to the Fast tier for the active provider.
 * Stagehand reads API keys from env (ANTHROPIC_API_KEY, OPENAI_API_KEY) automatically —
 * only xAI needs explicit baseURL/apiKey since Stagehand doesn't support it natively.
 */
function getStagehandModelConfig():
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

// --- Lifecycle ---

async function createInstance(): Promise<Stagehand> {
  const modelConfig = getStagehandModelConfig();

  if (isCloud) {
    const stagehand = new Stagehand({
      env: "BROWSERBASE",
      apiKey: config.BROWSERBASE_API_KEY!,
      projectId: config.BROWSERBASE_PROJECT_ID!,
      model: modelConfig,
      selfHeal: true,
      disablePino: true,
      verbose: STAGEHAND_VERBOSE,
      logger: stagehandLogger,
    });

    await runWithSpan("browser.init", () => stagehand.init());
    logger.info("Browser initialized (Browserbase cloud)");
    return stagehand;
  }

  const { cacheDir, profileDir } = ensureDirs();
  const geolocation = parseGeolocation();

  // Geolocation and permissions are BrowserContextOptions — valid for
  // launchPersistentContext which Stagehand uses when userDataDir is set.
  // Session persistence is handled entirely by userDataDir (Chromium's
  // built-in profile dir persists cookies, localStorage, IndexedDB, etc.)
  const launchOptions: Record<string, unknown> = {
    headless: config.BROWSER_HEADLESS,
    userDataDir: profileDir,
  };
  if (geolocation) {
    launchOptions.geolocation = geolocation;
    launchOptions.permissions = ["geolocation"];
  }

  const stagehand = new Stagehand({
    env: "LOCAL",
    model: modelConfig,
    selfHeal: true,
    cacheDir,
    disablePino: true,
    verbose: STAGEHAND_VERBOSE,
    logger: stagehandLogger,
    localBrowserLaunchOptions: launchOptions,
  });

  await runWithSpan("browser.init", () => stagehand.init());

  if (geolocation) {
    logger.info({ geolocation }, "Browser geolocation set");
  }
  logger.info("Browser initialized (local)");
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
  lockChain = Promise.resolve();

  if (current) {
    try {
      await current.close();
      logger.info("Browser shut down");
    } catch (err) {
      logger.warn({ error: err }, "Error closing browser");
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
  lockChain = Promise.resolve();
}
