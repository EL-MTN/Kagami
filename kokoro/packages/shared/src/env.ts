import { z } from "zod";
import { defineEnv, kansokuShipper, kaoConsumer, type EnvOutput } from "@kagami/env";

/**
 * Kokoro env spec — the single source of truth for the bot's (and, via the
 * @kokoro/db barrel, the dashboard's) configuration. `apps/bot/.env.example`,
 * the docs/configuration.md table, and `apps/bot/turbo.json` are generated
 * from it: edit here, then `npm run env:gen`.
 *
 * This module must stay a leaf (zod + @kagami/env only) so the workspace
 * generator can import it without booting the bot. The runtime contract
 * (module-scope exit-on-invalid parse with cross-checks skipped, plus
 * validateConfig() running the eight cross-field rule groups) lives in
 * config.ts.
 *
 * Two intentional deltas vs. the pre-migration config.ts, both from the
 * uniform record-level emptyStringAsUndefined (which replaces the per-var
 * preprocess kokoro hand-applied to only SOME keys):
 *   1. A blank value on a defaulted var falls back to the default
 *      (e.g. LLM_MODEL="" → "claude-sonnet-4-6"; previously stayed "").
 *   2. Kept values are trimmed (Kao/Kizuna already did this; Kokoro didn't).
 * Plus one drift-close from adopting the kaoConsumer block: KAO_TOKEN now
 * enforces the same ≥16-char floor and host-only KAO_URL that Kizuna and Kao
 * itself already enforced.
 */

// MCP (Model Context Protocol) servers Kokoro connects to as a CLIENT,
// mounting their tools alongside the built-in palette
// (namespaced `mcp_<server>_<tool>`). `http`/`sse` are remote transports;
// `stdio` spawns a local subprocess. Server names are constrained to a
// tool-name-safe charset so the namespacing prefix is collision-free
// without sanitization.
const mcpServerNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_-]+$/, "MCP server name must match [a-zA-Z0-9_-]");

const mcpHttpServerSchema = z.object({
  name: mcpServerNameSchema,
  transport: z.enum(["http", "sse"]),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const mcpStdioServerSchema = z.object({
  name: mcpServerNameSchema,
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

export const mcpServerSchema = z.union([mcpHttpServerSchema, mcpStdioServerSchema]);
export type McpServerConfig = z.infer<typeof mcpServerSchema>;

const kansoku = kansokuShipper();
const kao = kaoConsumer();

export const envSpec = defineEnv({
  service: "kokoro",
  component: "bot",
  vars: {
    TELEGRAM_BOT_TOKEN: z.string().optional().meta({
      doc: "Telegram bot token (primary platform).",
      secret: true,
      recommended: true,
      group: "Telegram",
    }),
    ALLOWED_USER_IDS: z
      .string()
      .default("")
      .transform((s) => (s ? s.split(",").map(Number) : []))
      .meta({
        doc: "Comma-separated numeric Telegram user ids allowed to talk to the bot.",
        example: "123456789,987654321",
        recommended: true,
        group: "Telegram",
      }),

    MONGODB_URI: z.string().default("mongodb://localhost:27017/kokoro").meta({
      doc: "MongoDB connection string.",
      crossService: true,
      group: "MongoDB",
    }),

    KIOKU_URL: z.string().url().default("https://api.kioku.localhost").meta({
      doc: "Kioku long-term memory service origin. Defaults to the Portless URL;\nuse http://localhost:7777 only when running Kioku standalone (its\nbind-port fallback). The client is fail-open — chat continues degraded\nwhen Kioku is unreachable.",
      crossService: true,
      group: "Sibling services",
    }),
    KIZUNA_URL: z.string().url().default("https://api.kizuna.localhost").meta({
      doc: "Kizuna CRM origin (context reads + confirmation-gated writes). Defaults\nto the Portless URL; use http://localhost:3000 only when running the\nKizuna API standalone. CRM tools are always registered; reads/writes fail\nopen if Kizuna is unreachable.",
      crossService: true,
      group: "Sibling services",
    }),

    LLM_KIND: z.enum(["native", "openai-compatible"]).default("native").meta({
      doc: "Chat inference kind — `native` (first-party provider SDKs via the\n@kagami/llm gateway) or `openai-compatible` (any OpenAI-shaped endpoint\nsuch as OpenRouter or a local server; requires LLM_BASE_URL +\nLLM_API_KEY).",
      group: "LLM",
    }),
    LLM_PROVIDER: z.enum(["anthropic", "openai", "xai"]).default("anthropic").meta({
      doc: "Native provider for chat (anthropic | openai | xai) — the matching\n*_API_KEY is required at bot startup under BOTH kinds. With\nLLM_KIND=openai-compatible, chat ignores it but browser automation\n(Stagehand) still selects its model and key from it.",
      group: "LLM",
    }),
    LLM_BASE_URL: z
      .string()
      .url()
      .regex(/^https?:\/\//, "LLM_BASE_URL must start with http:// or https://")
      .optional()
      .meta({
        doc: "OpenAI-compatible endpoint base URL — required when\nLLM_KIND=openai-compatible.",
        example: "https://openrouter.ai/api/v1",
        group: "LLM",
      }),
    LLM_PROVIDER_NAME: z.string().optional().meta({
      doc: 'Optional provider label surfaced in logs/spans when\nLLM_KIND=openai-compatible — unset lets the @kagami/llm gateway default\nto "openai-compatible" (native kinds label by vendor automatically).',
      example: "openrouter",
      group: "LLM",
    }),
    LLM_API_KEY: z.string().optional().meta({
      doc: "API key for the LLM_BASE_URL endpoint — required when\nLLM_KIND=openai-compatible (use any non-empty placeholder for local\nservers that don't enforce auth).",
      secret: true,
      group: "LLM",
    }),
    LLM_MODEL: z.string().default("claude-sonnet-4-6").meta({
      doc: "The Default model tier.",
      group: "LLM",
    }),
    LLM_MODEL_FAST: z.string().optional().meta({
      doc: "Optional Fast-tier override — unset = per-provider default (anthropic:\nclaude-haiku-4-5; openai-compatible kind falls back to LLM_MODEL). Used\nby getModel(Fast).",
      example: "claude-haiku-4-5",
      group: "LLM",
    }),
    LLM_MODEL_SMART: z.string().optional().meta({
      doc: "Optional Smart-tier override — unset = per-provider default (anthropic:\nclaude-sonnet-4-6; openai-compatible kind falls back to LLM_MODEL). Used\nby getModel(Smart).",
      example: "claude-sonnet-4-6",
      group: "LLM",
    }),
    LLM_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000).meta({
      doc: "Per-attempt chat deadline (ms). The @kagami/llm gateway aborts and\nretries an attempt that exceeds this, so a slow/hung provider response\nfails over fast instead of eating the conversational turn budget. This is\nthe per-attempt cap, NOT the turn budget — that's the per-call-site\nLLM_TIMEOUT_MS constants (generate.ts 120s, acknowledge.ts 60s,\nwatcher/routine 180s).",
      group: "LLM",
    }),
    ANTHROPIC_API_KEY: z.string().optional().meta({
      doc: "Anthropic API key — required when LLM_PROVIDER=anthropic (the default),\nunder both LLM_KIND values (browser automation uses the native provider\neven when chat is openai-compatible).",
      secret: true,
      recommended: true,
      group: "LLM",
    }),
    OPENAI_API_KEY: z.string().optional().meta({
      doc: "OpenAI API key — required when LLM_PROVIDER=openai; also the fallback\nkey for openai STT.",
      secret: true,
      group: "LLM",
    }),
    XAI_API_KEY: z.string().optional().meta({
      doc: "xAI API key — required when LLM_PROVIDER=xai or IMAGE_GENERATION_MODEL\nuses the xai provider.",
      secret: true,
      group: "LLM",
    }),
    GOOGLE_API_KEY: z.string().optional().meta({
      doc: "Google AI Studio key — required when IMAGE_GENERATION_MODEL=google/…",
      secret: true,
      group: "LLM",
    }),

    TIMEZONE: z.string().default("America/New_York").meta({
      doc: "IANA timezone; used for prompts, schedulers, and calendar formatting.",
      group: "App",
    }),
    CONTEXT_PATH: z.string().default("./context").meta({
      doc: "Location of soul.md, instructions/*.md, and reference images.",
      group: "App",
    }),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info").meta({
      doc: "Pino log level.",
      group: "App",
    }),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development").meta({
      doc: "Runtime environment.",
      group: "App",
    }),

    IMAGE_GENERATION_MODEL: z.string().optional().meta({
      doc: 'Image generation model, "provider/model" format. Provider keys are\nreused from the LLM section (so xai/* needs XAI_API_KEY, etc.). When\nunset, the sendPhoto tool is omitted from Kokoro\'s tool palette.',
      example: "xai/grok-imagine-image",
      group: "Image generation",
    }),

    STT_PROVIDER: z.string().optional().meta({
      doc: 'Inbound speech-to-text, "provider/model" format — see docs/voice.md.\nOnly the "openai" provider surface is supported; local whisper.cpp is\njust STT_BASE_URL pointing at the local OpenAI-compatible server.',
      example: "openai/whisper-1",
      group: "Voice",
    }),
    STT_BASE_URL: z.string().optional().meta({
      doc: "STT endpoint override for local whisper.cpp (OpenAI-compatible\n/v1/audio/transcriptions).",
      example: "http://127.0.0.1:8089/v1",
      group: "Voice",
    }),
    STT_API_KEY: z.string().optional().meta({
      doc: "STT API key. Any non-empty string works for whisper.cpp servers that\ndon't enforce auth; unset falls back to OPENAI_API_KEY.",
      secret: true,
      group: "Voice",
    }),
    TTS_PROVIDER: z.string().optional().meta({
      doc: 'Outbound text-to-speech (sendVoice tool), "provider/model" format.\nRequires TTS_VOICE_ID, and the provider\'s key (elevenlabs →\nELEVENLABS_API_KEY).',
      example: "elevenlabs/eleven_v3",
      group: "Voice",
    }),
    TTS_VOICE_ID: z.string().optional().meta({
      doc: "Voice id for the configured TTS provider.",
      group: "Voice",
    }),
    ELEVENLABS_API_KEY: z.string().optional().meta({
      doc: "ElevenLabs API key — required when TTS_PROVIDER uses elevenlabs.",
      secret: true,
      group: "Voice",
    }),

    // Google services (Gmail + Calendar + reminders) are vended via the Kao
    // identity service — Kokoro does not own a refresh token. The 'kokoro'
    // grant in Kao's registry is consented for gmail.readonly + gmail.send +
    // calendar; consent is granted at ${KAO_URL}/oauth/kokoro/start. When the
    // pair is unset, the email/calendar/reminder tools and the maid-service
    // instructions are dropped from the LLM context entirely.
    ...kao.vars,

    BRAVE_SEARCH_API_KEY: z.string().optional().meta({
      doc: "Brave Search API key (free tier: 2000 queries/month, 1 query/sec —\nhttps://brave.com/search/api/). When set, the LLM gets a fast no-browser\nwebSearch tool and the in-browser `search` action is dropped from the\nbrowse tool.",
      secret: true,
      group: "Web search",
    }),

    BROWSER_ENV: z.enum(["local", "cloud"]).default("local").meta({
      doc: "Browser tool mode: local (Playwright Chromium) | cloud (Browserbase).\nThe browser tool is always on; cloud mode requires the Browserbase\ncredentials below.",
      group: "Browser tool",
    }),
    BROWSERBASE_API_KEY: z.string().optional().meta({
      doc: "Browserbase API key — required when BROWSER_ENV=cloud.",
      secret: true,
      group: "Browser tool",
    }),
    BROWSERBASE_PROJECT_ID: z.string().optional().meta({
      doc: "Browserbase project id — required when BROWSER_ENV=cloud.",
      group: "Browser tool",
    }),
    BROWSER_MODEL: z.string().optional().meta({
      doc: "Model override for the browser-driving agent.",
      example: "anthropic/claude-haiku-4-5",
      group: "Browser tool",
    }),
    BROWSER_GEOLOCATION: z.string().optional().meta({
      doc: "lat,lng for emulated geolocation.",
      example: "40.7128,-74.0060",
      group: "Browser tool",
    }),
    BROWSER_DATA_DIR: z.string().default("./data/browser").meta({
      doc: "Persistent browser profile directory (local mode).",
      group: "Browser tool",
    }),
    BROWSER_HEADLESS: z
      .string()
      .default("true")
      .transform((s) => s === "true")
      .meta({
        doc: 'Headless browser toggle — only the literal "true" is truthy.',
        group: "Browser tool",
      }),

    EXECUTE_CODE_ENABLED: z
      .string()
      .default("false")
      .transform((s) => s === "true")
      .meta({
        doc: 'executeCode tool: runs LLM-written Python/Node scripts in a locked-down\nephemeral Docker container (no network, empty env, read-only rootfs,\nmemory/CPU/pid caps — see apps/bot/src/services/code-sandbox.ts).\nRequires a local Docker daemon at runtime; the tool fails open per call\nwhen the daemon is down. Every run is tap-to-approve and the bubble shows\nthe full code. Only the literal "true" enables — "false", empty, and\nunset all leave the tool off (the emergency off switch works without\ndeleting the var).',
        group: "Sandboxed code execution",
      }),
    EXECUTE_CODE_PYTHON_IMAGE: z.string().default("python:3.12-slim").meta({
      doc: "Docker image for Python runs.",
      group: "Sandboxed code execution",
    }),
    EXECUTE_CODE_NODE_IMAGE: z.string().default("node:22-slim").meta({
      doc: "Docker image for Node runs.",
      group: "Sandboxed code execution",
    }),
    EXECUTE_CODE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000).meta({
      doc: "Wall-clock cap per sandboxed run (ms).",
      group: "Sandboxed code execution",
    }),
    EXECUTE_CODE_MEMORY_MB: z.coerce.number().int().positive().default(512).meta({
      doc: "Hard memory cap per run (swap pinned to the same value).",
      group: "Sandboxed code execution",
    }),

    WORKSPACE_ENABLED: z
      .string()
      .default("false")
      .transform((s) => s === "true")
      .meta({
        doc: 'Persistent file workspace: one global file tree (GridFS-backed, shared\nacross every chat, channel, and routine) exposed to the model via the\nlistFiles/readFile/writeFile/deleteFile tools. Deletes are soft (30-day\ntrash, purged by daily maintenance). Only the literal "true" enables.',
        group: "Persistent workspace",
      }),
    WORKSPACE_MAX_FILE_MB: z.coerce.number().int().positive().default(25).meta({
      doc: "Per-file size cap (MB) — matches the inbound media caps.",
      group: "Persistent workspace",
    }),
    WORKSPACE_MAX_TOTAL_MB: z.coerce.number().int().positive().default(256).meta({
      doc: "Total live workspace size cap (MB). Writes that would breach fail with\na clear reason so the model can clean up.",
      group: "Persistent workspace",
    }),
    WORKSPACE_MAX_FILES: z.coerce.number().int().positive().default(500).meta({
      doc: "Max live (non-trashed) files in the workspace.",
      group: "Persistent workspace",
    }),

    GOOGLE_MAPS_API_KEY: z.string().optional().meta({
      doc: "Optional geocoding key for location awareness — without it, geocoding\ndegrades to raw coordinates (reverseGeocode returns null); never a hard\nrequirement.",
      secret: true,
      group: "Location awareness",
    }),
    LOCATION_MOVEMENT_THRESHOLD_M: z.coerce.number().default(100).meta({
      doc: "Movement distance (meters) that counts as a location change.",
      group: "Location awareness",
    }),
    LOCATION_PROACTIVE_DELAY_MS: z.coerce.number().default(1_200_000).meta({
      doc: "Quiet delay (ms) before proactive location-triggered engagement.",
      group: "Location awareness",
    }),
    LOCATION_CONTEXT_MAX_AGE_H: z.coerce.number().default(12).meta({
      doc: "Max age (hours) of a location fix still injected into context.",
      group: "Location awareness",
    }),
    PLACE_LEARNING_VISITS: z.coerce.number().int().positive().default(3).meta({
      doc: "Distinct visits before an unlabeled spot is proposed as a learned place.",
      group: "Location awareness",
    }),
    PLACE_LEARNING_RADIUS_M: z.coerce.number().positive().default(200).meta({
      doc: "Clustering radius (meters) for place learning.",
      group: "Location awareness",
    }),
    PLACE_LEARNING_WINDOW_DAYS: z.coerce.number().int().positive().default(30).meta({
      doc: "Sliding window (days) for counting place-learning visits.",
      group: "Location awareness",
    }),

    BLUEBUBBLES_HOST: z.string().optional().meta({
      doc: "BlueBubbles server URL for the iMessage adapter — see docs/imessage.md.\nTelegram and iMessage can run side-by-side.",
      example: "http://192.168.1.10:1234",
      group: "iMessage (BlueBubbles)",
    }),
    BLUEBUBBLES_PASSWORD: z.string().optional().meta({
      doc: "BlueBubbles password; authenticates both outbound API calls and inbound\nwebhook posts.",
      secret: true,
      group: "iMessage (BlueBubbles)",
    }),
    BLUEBUBBLES_WEBHOOK_PORT: z.coerce.number().default(4000).meta({
      doc: "Local port the BlueBubbles webhook listener binds.",
      group: "iMessage (BlueBubbles)",
    }),
    ALLOWED_IMESSAGE_HANDLES: z
      .string()
      .default("")
      .transform((s) =>
        s
          ? s
              .split(",")
              .map((h) => h.trim())
              .filter(Boolean)
          : [],
      )
      .meta({
        doc: "Comma-separated iMessage handles (phone numbers / iCloud emails)\nallowed to talk to the bot. Non-empty requires BLUEBUBBLES_HOST.",
        example: "",
        group: "iMessage (BlueBubbles)",
      }),

    // A malformed JSON string is left as-is by the preprocess so the array
    // schema reports a clear "expected array" error rather than silently
    // dropping the value.
    MCP_SERVERS: z
      .preprocess((v) => {
        if (v === undefined) return [];
        if (typeof v !== "string") return v;
        const trimmed = v.trim();
        if (trimmed === "") return [];
        try {
          return JSON.parse(trimmed) as unknown;
        } catch {
          return trimmed;
        }
      }, z.array(mcpServerSchema).default([]))
      .meta({
        doc: 'External MCP servers Kokoro connects to as a client; their tools are\nmounted into the conversational palette, namespaced `mcp_<server>_<tool>`.\nJSON array; unset/empty = no MCP tools. Each server is fail-open at\nconnect time (an unreachable server is logged and skipped). Transports:\n"http"/"sse" (remote; { name, transport, url, headers? }) and "stdio"\n(local subprocess; { name, transport, command, args?, env?, cwd? }).\n`name` must be unique and match [a-zA-Z0-9_-]. MCP tools are NOT offered\nto read-only watcher ticks. See docs/ai-layer.md.',
        example: "",
        group: "MCP servers",
      }),

    ROUTINE_PROPOSAL_COOLDOWN_DAYS: z.coerce.number().int().positive().default(14).meta({
      doc: 'Base quiet window (days) after a declined routine/skill proposal\n(escalates on repeat declines) so a "no" isn\'t re-offered for a while.\nProposals are always human-approved via tap-to-approve; never autonomous.\nSee docs/ai-layer.md.',
      group: "Self-authored routines",
    }),

    ...kansoku.vars,
  },
  cross: [
    // 1. LLM kind/provider → credential pairings. The native keyMap check
    // runs under BOTH kinds: browser automation (Stagehand) selects its model
    // and key from LLM_PROVIDER even when chat runs on an openai-compatible
    // endpoint.
    (config) => {
      const issues: string[] = [];
      if (config.LLM_KIND === "openai-compatible") {
        if (!config.LLM_BASE_URL) {
          issues.push('LLM_BASE_URL is required when LLM_KIND is "openai-compatible"');
        }
        if (!config.LLM_API_KEY) {
          issues.push(
            'LLM_API_KEY is required when LLM_KIND is "openai-compatible" (any non-empty placeholder works for local servers that don\'t enforce auth)',
          );
        }
      } else if (config.LLM_BASE_URL || config.LLM_API_KEY) {
        issues.push(
          'LLM_BASE_URL / LLM_API_KEY are set but ignored when LLM_KIND is "native" — did you mean LLM_KIND=openai-compatible?',
        );
      }
      const keyMap = {
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
        xai: "XAI_API_KEY",
      } as const;
      const required = keyMap[config.LLM_PROVIDER];
      if (!config[required]) {
        issues.push(
          `${required} is required when LLM_PROVIDER is "${config.LLM_PROVIDER}"${
            config.LLM_KIND === "openai-compatible"
              ? " (browser automation/Stagehand uses the native provider even when chat is openai-compatible)"
              : ""
          }`,
        );
      }
      return issues;
    },
    // 2. IMAGE_GENERATION_MODEL "provider/model" format + provider key
    (config) => {
      if (!config.IMAGE_GENERATION_MODEL) return [];
      const slash = config.IMAGE_GENERATION_MODEL.indexOf("/");
      if (slash === -1) {
        return [
          'IMAGE_GENERATION_MODEL must be in "provider/model" format (e.g., "xai/grok-imagine-image")',
        ];
      }
      const provider = config.IMAGE_GENERATION_MODEL.slice(0, slash);
      const imageKeyMap: Record<
        string,
        "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "XAI_API_KEY" | "GOOGLE_API_KEY" | undefined
      > = {
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
        xai: "XAI_API_KEY",
        google: "GOOGLE_API_KEY",
      };
      const requiredKey = imageKeyMap[provider];
      return requiredKey && !config[requiredKey]
        ? [`${requiredKey} is required when IMAGE_GENERATION_MODEL uses "${provider}" provider`]
        : [];
    },
    // 3. Kao both-or-neither — half-configured means the gates that activate
    // the maid-service tool stack would fire while runtime calls 401 at Kao.
    ...kao.cross,
    // 4. TTS provider/model format + provider key + voice id
    (config) => {
      if (!config.TTS_PROVIDER) return [];
      const issues: string[] = [];
      const slash = config.TTS_PROVIDER.indexOf("/");
      if (slash === -1) {
        issues.push(
          'TTS_PROVIDER must be in "provider/model" format (e.g., "elevenlabs/eleven_flash_v2_5")',
        );
      } else if (
        config.TTS_PROVIDER.slice(0, slash) === "elevenlabs" &&
        !config.ELEVENLABS_API_KEY
      ) {
        issues.push('ELEVENLABS_API_KEY is required when TTS_PROVIDER uses "elevenlabs" provider');
      }
      if (!config.TTS_VOICE_ID) {
        issues.push("TTS_VOICE_ID is required when TTS_PROVIDER is set");
      }
      return issues;
    },
    // 5. Browser cloud mode needs Browserbase credentials. (Local mode — the
    // default — drives Playwright and needs none. A missing
    // GOOGLE_MAPS_API_KEY never gates location: geocoding degrades to raw
    // coordinates.)
    (config) => {
      if (config.BROWSER_ENV !== "cloud") return [];
      const issues: string[] = [];
      if (!config.BROWSERBASE_API_KEY) {
        issues.push('BROWSERBASE_API_KEY is required when BROWSER_ENV is "cloud"');
      }
      if (!config.BROWSERBASE_PROJECT_ID) {
        issues.push('BROWSERBASE_PROJECT_ID is required when BROWSER_ENV is "cloud"');
      }
      return issues;
    },
    // 6. MCP server names become tool-name prefixes (mcp_<name>_<tool>) and
    // must be unique so two servers can't shadow each other's namespace.
    (config) => {
      const names = config.MCP_SERVERS.map((s) => s.name);
      const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
      return dupes.length > 0
        ? [`MCP_SERVERS has duplicate server name(s): ${dupes.join(", ")}`]
        : [];
    },
    // 7. BlueBubbles pairings
    (config) => {
      const issues: string[] = [];
      if (config.BLUEBUBBLES_HOST && !config.BLUEBUBBLES_PASSWORD) {
        issues.push("BLUEBUBBLES_PASSWORD is required when BLUEBUBBLES_HOST is set");
      }
      if (config.ALLOWED_IMESSAGE_HANDLES.length > 0 && !config.BLUEBUBBLES_HOST) {
        issues.push("BLUEBUBBLES_HOST is required when ALLOWED_IMESSAGE_HANDLES is non-empty");
      }
      return issues;
    },
    // 8. STT provider format, openai-only, key fallback. Cloud OpenAI and
    // local whisper.cpp both use the OpenAI-compatible
    // /v1/audio/transcriptions endpoint, so the only "provider" surface
    // recognised today is "openai" — local mode is just STT_BASE_URL
    // pointing at the local server.
    (config) => {
      if (!config.STT_PROVIDER) return [];
      const slash = config.STT_PROVIDER.indexOf("/");
      if (slash === -1) {
        return ['STT_PROVIDER must be in "provider/model" format (e.g., "openai/whisper-1")'];
      }
      const issues: string[] = [];
      const provider = config.STT_PROVIDER.slice(0, slash);
      if (provider !== "openai") {
        issues.push(
          `STT_PROVIDER unknown provider "${provider}" — only "openai" is supported (use STT_BASE_URL for local servers)`,
        );
      }
      if (!config.STT_API_KEY && !config.OPENAI_API_KEY) {
        issues.push(
          "STT_API_KEY or OPENAI_API_KEY is required when STT_PROVIDER is set (use any non-empty placeholder for local whisper.cpp servers that don't enforce auth)",
        );
      }
      return issues;
    },
  ],
});

export type Config = EnvOutput<typeof envSpec>;
