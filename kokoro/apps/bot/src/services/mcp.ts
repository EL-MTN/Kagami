import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { config, logger, type McpServerConfig } from "@kokoro/shared";
import type { ToolSet } from "ai";

// Kokoro as an MCP *client*: at startup it connects to the servers in
// MCP_SERVERS, lists each one's tools, namespaces them, and caches them so
// `allTools()` can merge them into the conversational palette. This is the
// extensibility seam — adding a capability becomes a config line instead of a
// hand-written tool module.
//
// Everything here is fail-open, matching the Kioku/Kizuna client posture: a
// server that won't connect (or whose tool listing fails) is logged and
// skipped, never crashing the bot. MCP tools are deliberately mounted ONLY in
// the "main" palette (see tools/index.ts) — the watcher read-only subset stays
// free of external tools whose read/write purity we can't classify.

// Per-server connect + list-tools deadline. A wedged or slow MCP server must
// not pin bot startup — the race rejects, the server is skipped (fail-open).
const CONNECT_TIMEOUT_MS = 15_000;

// AI SDK / provider tool-name ceiling. Namespaced keys are capped here so a long
// server or tool name can't produce an over-length (provider-rejected) key.
const MAX_TOOL_NAME_LEN = 64;

export interface McpServerSummary {
  name: string;
  transport: McpServerConfig["transport"];
  /** Namespaced tool keys (mcp_<server>_<tool>) contributed by this server. */
  toolNames: string[];
  /** Optional usage hint the server reported during the initialize handshake. */
  instructions?: string;
}

let clients: MCPClient[] = [];
let mcpTools: ToolSet = {};
let connected: McpServerSummary[] = [];

/**
 * Namespaced tool key: `mcp_<server>_<tool>`, capped at the provider tool-name
 * ceiling. The `mcp_` prefix guarantees no collision with the built-in palette
 * (sendPhoto, searchMemory, …); the server segment disambiguates same-named
 * tools across servers. Server names are pre-validated to [a-zA-Z0-9_-] by the
 * config schema, so only the tool segment can carry exotic characters.
 */
export function namespacedToolName(server: string, tool: string): string {
  const safeTool = tool.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `mcp_${server}_${safeTool}`.slice(0, MAX_TOOL_NAME_LEN);
}

/**
 * Namespace a server's raw tool set and drop any intra-server key collisions
 * (two tool names that collapse to the same key after the 64-char cap). The
 * returned `toolNames` stays in sync with `tools` — no stale or duplicate keys,
 * so the prompt never advertises a key that maps to a different tool.
 */
export function namespaceServerTools(
  serverName: string,
  rawTools: ToolSet,
): { tools: ToolSet; toolNames: string[] } {
  const tools: ToolSet = {};
  const toolNames: string[] = [];
  for (const [toolName, tool] of Object.entries(rawTools)) {
    const key = namespacedToolName(serverName, toolName);
    if (key in tools) {
      logger.warn(
        { mcp: { server: serverName, tool: key } },
        "Duplicate MCP tool key within server (name truncation?) — keeping first, skipping",
      );
      continue;
    }
    tools[key] = tool;
    toolNames.push(key);
  }
  return { tools, toolNames };
}

function buildTransport(server: McpServerConfig) {
  if (server.transport === "stdio") {
    return new Experimental_StdioMCPTransport({
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
    });
  }
  return {
    type: server.transport,
    url: server.url,
    headers: server.headers,
    // Reject redirects: an MCP endpoint that 30x-redirects is a misconfig (and
    // an SSRF vector once Kokoro is exposed beyond localhost), not normal flow.
    redirect: "error" as const,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`MCP ${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

interface ConnectResult {
  client: MCPClient;
  summary: McpServerSummary;
  tools: ToolSet;
}

async function connectServer(server: McpServerConfig): Promise<ConnectResult | null> {
  // Hold the connect promise separately from the await: on a connect *timeout*
  // the race rejects but createMCPClient keeps running, so a late success must
  // still be closed (else a spawned stdio child / HTTP session leaks).
  const connectPromise = createMCPClient({ transport: buildTransport(server) });
  let keep = false;
  try {
    const client = await withTimeout(
      connectPromise,
      CONNECT_TIMEOUT_MS,
      `connect "${server.name}"`,
    );
    const rawTools = await withTimeout(
      client.tools(),
      CONNECT_TIMEOUT_MS,
      `list tools "${server.name}"`,
    );

    const { tools, toolNames } = namespaceServerTools(server.name, rawTools);

    keep = true;
    logger.info(
      { mcp: { server: server.name, transport: server.transport, tools: toolNames.length } },
      "MCP server connected",
    );
    return {
      client,
      tools,
      summary: {
        name: server.name,
        transport: server.transport,
        toolNames,
        instructions: client.instructions,
      },
    };
  } catch (error) {
    logger.warn(
      { error, mcp: { server: server.name, transport: server.transport } },
      "MCP server unavailable — skipping (fail-open)",
    );
    return null;
  } finally {
    // Not keeping this client (connect timeout, or a tools()/listing failure) —
    // close whatever the connect eventually yields so nothing leaks. No-op if
    // the connect rejected; harmless if it never resolves.
    if (!keep) void connectPromise.then((c) => c.close()).catch(() => undefined);
  }
}

/**
 * Connect to every configured MCP server and cache their (namespaced) tools.
 * Fail-open per server. Call once at boot. `servers` is injectable for tests;
 * defaults to config.MCP_SERVERS.
 */
export async function initMcp(servers: McpServerConfig[] = config.MCP_SERVERS): Promise<void> {
  if (servers.length === 0) return;

  logger.info({ mcp: { count: servers.length } }, "Connecting to MCP servers...");
  const results = await Promise.all(servers.map(connectServer));

  for (const result of results) {
    if (!result) continue;
    clients.push(result.client);
    connected.push(result.summary);
    for (const [key, tool] of Object.entries(result.tools)) {
      if (key in mcpTools) {
        logger.warn({ mcp: { tool: key } }, "Duplicate MCP tool key — keeping first, skipping");
        continue;
      }
      mcpTools[key] = tool;
    }
  }

  logger.info(
    { mcp: { servers: connected.length, tools: Object.keys(mcpTools).length } },
    "MCP initialization complete",
  );
}

/** Cached, namespaced MCP tools. Empty until initMcp resolves (and after shutdown). */
export function getMcpTools(): Readonly<ToolSet> {
  return mcpTools;
}

/** Per-server summary for the system prompt (server → tool names + instructions). */
export function getMcpSummary(): McpServerSummary[] {
  return connected;
}

/** Close all MCP clients (process shutdown). Resets cached state. */
export async function shutdownMcp(): Promise<void> {
  const current = clients;
  clients = [];
  connected = [];
  mcpTools = {};
  if (current.length === 0) return;
  await Promise.allSettled(current.map((c) => c.close()));
  logger.info({ mcp: { closed: current.length } }, "MCP clients shut down");
}
