// Kansoku debug CLI — agent-friendly read-only window into the observability
// service. Designed to be invoked by a human or a Claude Code agent that needs
// to inspect a trace, search logs, or scan recent errors without standing up
// the dashboard.
//
// Usage (from the Kagami workspace root):
//   npm run kansoku:debug -- <subcommand> [...]
//
// Subcommands:
//   trace <traceId>                       Full trace (waterfall + log timeline)
//   logs [filters]                        Search logs
//     --service S  --level L  --since ISO  --until ISO
//     --limit N (default 100, max 1000)
//   errors [filters]                      Fingerprinted error registry
//     --service S  --limit N (default 100, max 500)
//   services [--window H]                 Per-service summary (default 24h)
//   help                                  Print this usage
//
// Global flags:
//   --json                                Raw JSON instead of pretty text
//   --url <baseUrl>                       Override base URL
//                                         (default: KANSOKU_URL env or
//                                          https://api.kansoku.localhost)
//
// Examples:
//   npm run kansoku:debug -- trace 7a4e9b3c5d6f1a8e2b0c4d5f6a7b8c9d
//   npm run kansoku:debug -- logs --service kokoro-bot --level error --limit 50
//   npm run kansoku:debug -- errors --service kioku-api
//   npm run kansoku:debug -- services --window 6
//
// Note: --service is an exact-match filter, not a prefix. Use the full
// stored name: kokoro-bot, kioku-api, kizuna-api, kansoku-api, kao-api.
//
// Notes:
// - Query endpoints are currently unauthenticated. Acceptable today because
//   the API only binds to 127.0.0.1 under Portless. Before any VPS exposure
//   the read surface must be gated — see ARCHITECTURE.md.
// - Portless serves the API behind a locally-trusted CA that Node does NOT
//   include in its bundled CA list. For *.localhost targets we issue requests
//   through node:https with rejectUnauthorized:false (request-scoped, not
//   process-wide). Public URLs (anything else) keep full TLS verification.

import https from "node:https";
import http from "node:http";

const DEFAULT_BASE = process.env.KANSOKU_URL ?? "https://api.kansoku.localhost";
const TRACE_ID_RE = /^[0-9a-f]{32}$/i;

interface StoredLog {
  ts: string;
  meta: { service: string; component: string; env: string; level: string };
  msg?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  fields?: Record<string, unknown>;
}

interface StoredSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  service: string;
  component: string;
  startedAt: string;
  durationMs: number;
  status: "ok" | "error";
}

interface TraceResponse {
  traceId: string;
  logs: StoredLog[];
  spans?: StoredSpan[];
}

interface ErrorRecord {
  _id: string;
  service: string;
  component: string;
  name?: string;
  message: string;
  sampleMsg?: string;
  sampleStack?: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  recentTraceIds: string[];
}

interface ServiceSummary {
  service: string;
  count: number;
  errorCount: number;
  warnCount: number;
  lastSeen: string | null;
  components: string[];
}

function usage(exitCode = 0): never {
  const text = `kansoku-debug — observability read-only CLI

Usage:
  npm run kansoku:debug -- <subcommand> [...] [--json] [--url BASE]

Subcommands:
  trace <traceId>                Full trace by 32-hex-char ID
  logs [filters]                 Search logs:
                                   --service S  --level L
                                   --since ISO  --until ISO
                                   --limit N (default 100, max 1000)
  errors [filters]               Fingerprinted error registry:
                                   --service S
                                   --limit N (default 100, max 500)
  services [--window H]          Per-service summary (default window 24h)
  help                           Print this usage

Examples:
  npm run kansoku:debug -- trace 7a4e9b3c5d6f1a8e2b0c4d5f6a7b8c9d
  npm run kansoku:debug -- logs --service kokoro-bot --level error --limit 50
  npm run kansoku:debug -- errors --service kioku-api
  npm run kansoku:debug -- services --window 6

Service names are exact-match (no prefix):
  kokoro-bot, kioku-api, kizuna-api, kansoku-api, kao-api
`;
  process.stdout.write(text);
  process.exit(exitCode);
}

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

// Flags that take no value. Listed explicitly because the parser otherwise
// has no way to tell `--json trace <id>` (where `trace` is the subcommand,
// not the flag's value) from `--service kokoro-bot` (where the next token
// IS the value). Without this set, `--json trace <id>` would silently turn
// into flags.json="trace" and the subcommand would be lost.
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["json"]);

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function isLocalhost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

interface HttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
}

/**
 * Plain http(s).request wrapper. The advantage over global fetch here is
 * `rejectUnauthorized:false` is a *per-request* option — we don't have to
 * disable TLS verification process-wide (which Node would loudly warn
 * about on every invocation) just because Portless's local CA isn't in
 * Node's bundled root store.
 */
function request(url: string, opts: { rejectUnauthorized: boolean }): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;
    const reqOpts: https.RequestOptions = {
      method: "GET",
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers: { accept: "application/json" },
    };
    if (isHttps) reqOpts.rejectUnauthorized = opts.rejectUnauthorized;
    const req = lib.request(reqOpts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText: res.statusMessage ?? "",
          body,
        });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

async function apiGet<T>(baseUrl: string, path: string): Promise<T> {
  const url = `${baseUrl}${path}`;
  let res: HttpResponse;
  try {
    res = await request(url, { rejectUnauthorized: !isLocalhost(baseUrl) });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const detail = code ?? (err as Error).message;
    throw new Error(`Network failure calling ${url}: ${detail}`, { cause: err });
  }
  if (!res.ok) {
    const snippet = res.body.slice(0, 300);
    throw new Error(`${url} -> ${res.status} ${res.statusText}${snippet ? `: ${snippet}` : ""}`);
  }
  try {
    return JSON.parse(res.body) as T;
  } catch (err) {
    throw new Error(`${url}: response was not JSON (first 200 chars: ${res.body.slice(0, 200)})`, {
      cause: err,
    });
  }
}

function fmtTs(s: string): string {
  // 2026-05-20T14:23:08.123Z → 14:23:08.123  (just the time part for compact lists)
  const m = /T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(s);
  return m?.[1] ?? s;
}

function fmtTsFull(s: string): string {
  // YYYY-MM-DD HH:MM:SS.mmm
  return s.replace("T", " ").replace(/Z$/, "");
}

function fmtLevel(level: string): string {
  return level.toUpperCase().padEnd(5);
}

function compactFields(fields: Record<string, unknown> | undefined): string {
  if (!fields) return "";
  // Drop the heavy / redundant pieces. Anything left is genuine context.
  const drop = new Set([
    "log",
    "@timestamp",
    "service",
    "host",
    "process",
    "trace",
    "span",
    "event",
    "ecs",
    "message",
  ]);
  const trimmed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (drop.has(k)) continue;
    trimmed[k] = v;
  }
  const keys = Object.keys(trimmed);
  if (keys.length === 0) return "";
  // Cap to keep log lines scan-friendly.
  const out = JSON.stringify(trimmed);
  return out.length > 240 ? `${out.slice(0, 237)}...` : out;
}

interface SpanNode {
  spanId: string;
  parentSpanId?: string;
  name?: string;
  service: string;
  component: string;
  startMs: number;
  endMs: number;
  status: "ok" | "error";
  source: "real" | "log-derived";
  children: SpanNode[];
}

function buildSpanTreeFromSpans(spans: StoredSpan[]): SpanNode[] {
  const byId = new Map<string, SpanNode>();
  for (const s of spans) {
    const startMs = new Date(s.startedAt).getTime();
    const node: SpanNode = {
      spanId: s.spanId,
      name: s.name,
      service: s.service,
      component: s.component,
      startMs,
      endMs: startMs + s.durationMs,
      status: s.status,
      source: "real",
      children: [],
    };
    if (s.parentSpanId !== undefined) node.parentSpanId = s.parentSpanId;
    byId.set(s.spanId, node);
  }
  const roots: SpanNode[] = [];
  for (const node of byId.values()) {
    if (node.parentSpanId && byId.has(node.parentSpanId)) {
      byId.get(node.parentSpanId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const byStart = (a: SpanNode, b: SpanNode): number => a.startMs - b.startMs;
  roots.sort(byStart);
  for (const n of byId.values()) n.children.sort(byStart);
  return roots;
}

function buildSpanTreeFromLogs(logs: StoredLog[]): SpanNode[] {
  // Fallback for traces predating build-light spans — group logs by spanId
  // and use their min/max timestamps as the span window.
  const bySpan = new Map<string, SpanNode>();
  for (const log of logs) {
    const spanId = log.spanId ?? "__none__";
    let node = bySpan.get(spanId);
    const t = new Date(log.ts).getTime();
    if (!node) {
      node = {
        spanId,
        service: log.meta.service,
        component: log.meta.component,
        startMs: t,
        endMs: t,
        status: "ok",
        source: "log-derived",
        children: [],
      };
      if (log.parentSpanId !== undefined) node.parentSpanId = log.parentSpanId;
      bySpan.set(spanId, node);
    }
    if (t < node.startMs) node.startMs = t;
    if (t > node.endMs) node.endMs = t;
    if (log.meta.level === "error" || log.meta.level === "fatal") node.status = "error";
  }
  const roots: SpanNode[] = [];
  for (const node of bySpan.values()) {
    if (node.parentSpanId && bySpan.has(node.parentSpanId)) {
      bySpan.get(node.parentSpanId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const byStart = (a: SpanNode, b: SpanNode): number => a.startMs - b.startMs;
  roots.sort(byStart);
  for (const n of bySpan.values()) n.children.sort(byStart);
  return roots;
}

function renderWaterfall(roots: SpanNode[], traceStartMs: number, traceTotalMs: number): string {
  const BAR_WIDTH = 40;
  const lines: string[] = [];
  const walk = (node: SpanNode, depth: number): void => {
    const offset = Math.max(0, node.startMs - traceStartMs);
    const dur = Math.max(0, node.endMs - node.startMs);
    const offsetCells = Math.floor((offset / traceTotalMs) * BAR_WIDTH);
    const durCells = Math.max(1, Math.floor((dur / traceTotalMs) * BAR_WIDTH));
    const bar =
      " ".repeat(Math.min(offsetCells, BAR_WIDTH)) +
      (node.status === "error" ? "!" : "=").repeat(Math.min(durCells, BAR_WIDTH - offsetCells));
    const padded = bar.padEnd(BAR_WIDTH);
    const indent = "  ".repeat(depth);
    const label = `${node.service}/${node.component}${node.name ? ` ${node.name}` : ""}`;
    const status = node.status === "error" ? " [ERR]" : "";
    lines.push(`  [${padded}] ${dur.toString().padStart(6)}ms  ${indent}${label}${status}`);
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return lines.join("\n");
}

function flattenSpans(roots: SpanNode[]): SpanNode[] {
  const out: SpanNode[] = [];
  const walk = (n: SpanNode): void => {
    out.push(n);
    for (const c of n.children) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}

async function cmdTrace(args: ParsedArgs, baseUrl: string, json: boolean): Promise<void> {
  const id = args.positional[1];
  if (!id) {
    process.stderr.write("trace: missing <traceId>\n\n");
    usage(2);
  }
  if (!TRACE_ID_RE.test(id)) {
    process.stderr.write(`trace: invalid trace id (must be 32 hex chars): ${id}\n`);
    process.exit(2);
  }
  const data = await apiGet<TraceResponse>(baseUrl, `/v1/traces/${encodeURIComponent(id)}`);
  if (json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  const { traceId, logs, spans = [] } = data;
  if (logs.length === 0 && spans.length === 0) {
    process.stdout.write(`Trace ${traceId}: no records found.\n`);
    process.stdout.write(
      "Note: time-series TTL defaults to 30 days — older traces are expired by Mongo.\n",
    );
    return;
  }

  const useRealSpans = spans.length > 0;
  const roots = useRealSpans ? buildSpanTreeFromSpans(spans) : buildSpanTreeFromLogs(logs);
  const flat = flattenSpans(roots);
  const traceStartMs = flat.reduce(
    (acc, s) => (s.startMs < acc ? s.startMs : acc),
    Number.POSITIVE_INFINITY,
  );
  const traceEndMs = flat.reduce(
    (acc, s) => (s.endMs > acc ? s.endMs : acc),
    Number.NEGATIVE_INFINITY,
  );
  const totalMs = Math.max(traceEndMs - traceStartMs, 1);
  const services = new Set(logs.map((l) => l.meta.service));

  process.stdout.write(`Trace ${traceId}\n`);
  process.stdout.write(
    `  started: ${new Date(traceStartMs).toISOString()}  duration: ${totalMs}ms\n`,
  );
  process.stdout.write(
    `  logs: ${logs.length}  spans: ${flat.length} (${useRealSpans ? "real" : "log-derived"})  services: ${[...services].sort().join(", ") || "—"}\n\n`,
  );

  process.stdout.write("Waterfall\n");
  process.stdout.write(renderWaterfall(roots, traceStartMs, totalMs));
  process.stdout.write("\n\n");

  process.stdout.write(`Log timeline (${logs.length} line${logs.length === 1 ? "" : "s"})\n`);
  const RENDER_CAP = 200;
  const toRender = logs.slice(0, RENDER_CAP);
  for (const log of toRender) {
    const fields = compactFields(log.fields);
    const span = log.spanId ? ` span=${log.spanId.slice(0, 8)}` : "";
    process.stdout.write(
      `  ${fmtTs(log.ts)} ${fmtLevel(log.meta.level)} ${log.meta.service}/${log.meta.component}${span}  ${log.msg ?? ""}${fields ? `  ${fields}` : ""}\n`,
    );
  }
  if (logs.length > RENDER_CAP) {
    process.stdout.write(
      `  ... ${logs.length - RENDER_CAP} more log line${logs.length - RENDER_CAP === 1 ? "" : "s"} omitted. Re-run with --json to dump everything.\n`,
    );
  }
}

async function cmdLogs(args: ParsedArgs, baseUrl: string, json: boolean): Promise<void> {
  const qs = new URLSearchParams();
  for (const key of ["service", "level", "since", "until", "limit"]) {
    const v = args.flags[key];
    if (typeof v === "string" && v.length > 0) qs.set(key, v);
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const data = await apiGet<{ logs: StoredLog[] }>(baseUrl, `/v1/logs${suffix}`);
  if (json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  if (data.logs.length === 0) {
    process.stdout.write("No logs matched.\n");
    return;
  }
  process.stdout.write(
    `${data.logs.length} log${data.logs.length === 1 ? "" : "s"} (newest first)\n`,
  );
  for (const log of data.logs) {
    const fields = compactFields(log.fields);
    const trace = log.traceId ? ` trace=${log.traceId.slice(0, 8)}` : "";
    process.stdout.write(
      `  ${fmtTsFull(log.ts)} ${fmtLevel(log.meta.level)} ${log.meta.service}/${log.meta.component}${trace}  ${log.msg ?? ""}${fields ? `  ${fields}` : ""}\n`,
    );
  }
  // If any rows carry a traceId, surface unique ones so the agent can drill in.
  const traceIds = new Set<string>();
  for (const l of data.logs) if (l.traceId) traceIds.add(l.traceId);
  if (traceIds.size > 0) {
    process.stdout.write(
      `\nUnique trace IDs in results (${traceIds.size}):\n${[...traceIds].map((t) => `  ${t}`).join("\n")}\n`,
    );
  }
}

async function cmdErrors(args: ParsedArgs, baseUrl: string, json: boolean): Promise<void> {
  const qs = new URLSearchParams();
  for (const key of ["service", "limit"]) {
    const v = args.flags[key];
    if (typeof v === "string" && v.length > 0) qs.set(key, v);
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const data = await apiGet<{ errors: ErrorRecord[] }>(baseUrl, `/v1/errors${suffix}`);
  if (json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  if (data.errors.length === 0) {
    process.stdout.write("No fingerprinted errors recorded.\n");
    return;
  }
  process.stdout.write(
    `${data.errors.length} fingerprint${data.errors.length === 1 ? "" : "s"} (most recent first)\n\n`,
  );
  for (const e of data.errors) {
    process.stdout.write(
      `[${e._id}] ${e.service}/${e.component}  count=${e.count}  lastSeen=${fmtTsFull(e.lastSeen)}\n`,
    );
    if (e.name) process.stdout.write(`  name: ${e.name}\n`);
    process.stdout.write(`  msg:  ${e.message}\n`);
    if (e.sampleStack) {
      const stack = e.sampleStack.split("\n").slice(0, 4).join("\n        ");
      process.stdout.write(`  stack: ${stack}\n`);
    }
    if (e.recentTraceIds.length > 0) {
      process.stdout.write(
        `  recent traces (${e.recentTraceIds.length}): ${e.recentTraceIds.slice(-5).join(", ")}\n`,
      );
    }
    process.stdout.write("\n");
  }
}

async function cmdServices(args: ParsedArgs, baseUrl: string, json: boolean): Promise<void> {
  const qs = new URLSearchParams();
  const w = args.flags.window;
  if (typeof w === "string") qs.set("windowHours", w);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const data = await apiGet<{ since: string; services: ServiceSummary[] }>(
    baseUrl,
    `/v1/services${suffix}`,
  );
  if (json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  if (data.services.length === 0) {
    process.stdout.write(`No services have logged since ${data.since}.\n`);
    return;
  }
  process.stdout.write(`Window since ${data.since}\n\n`);
  const header =
    "  service".padEnd(20) +
    "logs".padStart(10) +
    "errors".padStart(10) +
    "warns".padStart(10) +
    "  lastSeen".padEnd(28) +
    "components";
  process.stdout.write(`${header}\n`);
  for (const s of data.services) {
    process.stdout.write(
      "  " +
        s.service.padEnd(18) +
        s.count.toString().padStart(10) +
        s.errorCount.toString().padStart(10) +
        s.warnCount.toString().padStart(10) +
        "  " +
        (s.lastSeen ? fmtTsFull(s.lastSeen) : "—").padEnd(26) +
        s.components.join(", ") +
        "\n",
    );
  }
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  if (raw.length === 0 || raw[0] === "help" || raw[0] === "--help" || raw[0] === "-h") {
    usage(0);
  }
  const args = parseArgs(raw);
  const baseUrl =
    typeof args.flags.url === "string" && args.flags.url.length > 0
      ? args.flags.url.replace(/\/$/, "")
      : DEFAULT_BASE.replace(/\/$/, "");
  const json = args.flags.json === true;

  const sub = args.positional[0];
  try {
    switch (sub) {
      case "trace":
        await cmdTrace(args, baseUrl, json);
        break;
      case "logs":
        await cmdLogs(args, baseUrl, json);
        break;
      case "errors":
        await cmdErrors(args, baseUrl, json);
        break;
      case "services":
        await cmdServices(args, baseUrl, json);
        break;
      default:
        process.stderr.write(`Unknown subcommand: ${sub}\n\n`);
        usage(2);
    }
  } catch (err) {
    process.stderr.write(`kansoku-debug: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

void main();
