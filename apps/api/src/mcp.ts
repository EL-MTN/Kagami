import { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { query } from './query/answer.js';
import { recall } from './query/recall.js';
import { readFacts } from './storage/facts.js';
import { readHistoryFor } from './storage/history.js';
import { appendFactsBulk, appendSingleFact } from './ingest/append.js';
import { ingestSessionFromString } from './ingest/sessions.js';
import { logger } from './logger.js';

// Shared zod shape for the mem0-OSS-style filter payload, surfaced on
// every read tool that can prefilter. Mirrors src/routes/filters.ts but
// inlined here because the MCP SDK wants a plain ZodRawShape per tool.
const filtersShape = {
  user_id: z.string().optional(),
  run_id: z.string().optional(),
  agent_id: z.string().optional(),
  category: z.string().optional(),
  metadata: z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
};
const FiltersInput = z.object(filtersShape).optional();

// Streamable HTTP MCP surface, mounted at /mcp. Tools mirror the
// programmatic REST API but take JSON-shaped tool inputs and emit
// tool-result text payloads. External LLM clients (Claude Desktop,
// agents, etc.) talk to Kioku through this endpoint; the bot uses
// REST directly.

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function fail(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'kioku', version: '0.1.0' });

  server.registerTool(
    'recall',
    {
      description:
        'Return ranked atomic facts for a query — hybrid (cosine + BM25 + entity boost), no LLM. Use this when you want raw fact retrieval and will reason over the results yourself.',
      inputSchema: {
        query: z.string(),
        k: z.number().int().positive().max(100).optional(),
        since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        filters: FiltersInput,
      },
    },
    async ({ query: q, k, since, until, filters }) => {
      try {
        const facts = await recall(q, { k, since, until, filters });
        return ok(JSON.stringify({ facts, total: facts.length }));
      } catch (e) {
        return fail(String(e));
      }
    },
  );

  server.registerTool(
    'query',
    {
      description:
        'Answer a question from the memory vault using top-K atomic facts. Returns {answer, citations}. Use this when you want a synthesized answer; use `recall` if you want raw facts.',
      inputSchema: { question: z.string(), filters: FiltersInput },
    },
    async ({ question, filters }) => {
      try {
        return ok(JSON.stringify(await query(question, { filters })));
      } catch (e) {
        return fail(String(e));
      }
    },
  );

  server.registerTool(
    'append_fact',
    {
      description:
        'Add a single atomic fact to the vault. Dedups against existing facts (md5 + cosine). Returns {id, status: "added"|"duplicate"}.',
      inputSchema: {
        text: z.string(),
        event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        source_session: z.string().optional(),
        user_id: z.string().optional(),
        run_id: z.string().optional(),
        agent_id: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
        category: z.string().optional(),
      },
    },
    async (input) => {
      try {
        const result = await appendSingleFact(input);
        return ok(JSON.stringify(result));
      } catch (e) {
        return fail(String(e));
      }
    },
  );

  // mem0 OSS-style bulk infer=false: store N caller-supplied facts
  // verbatim, no LLM extraction. Each input is deduped and embedded
  // individually. Returns one result per input in order.
  const appendFactInputShape = {
    text: z.string(),
    event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    source_session: z.string().optional(),
    user_id: z.string().optional(),
    run_id: z.string().optional(),
    agent_id: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    category: z.string().optional(),
  };
  server.registerTool(
    'append_facts',
    {
      description:
        'Add multiple atomic facts to the vault in one call (no LLM extraction). Equivalent to mem0 add(infer=False). Each input is independently deduped (md5 + cosine). Returns {results, added, duplicates}.',
      inputSchema: {
        facts: z.array(z.object(appendFactInputShape)).min(1).max(500),
      },
    },
    async ({ facts }) => {
      try {
        const results = await appendFactsBulk(facts);
        const added = results.filter((r) => r.status === 'added').length;
        return ok(
          JSON.stringify({ results, added, duplicates: results.length - added }),
        );
      } catch (e) {
        return fail(String(e));
      }
    },
  );

  server.registerTool(
    'ingest_session',
    {
      description:
        'Extract atomic facts from a raw transcript string. Returns {sessionId, added, batches, summaryFactId}.',
      inputSchema: {
        transcript: z.string(),
        generate_summary: z.boolean().optional(),
        user_id: z.string().optional(),
        run_id: z.string().optional(),
        agent_id: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      },
    },
    async ({ transcript, generate_summary, user_id, run_id, agent_id, metadata }) => {
      try {
        const result = await ingestSessionFromString({
          transcript,
          generateSummary: generate_summary,
          user_id,
          run_id,
          agent_id,
          metadata,
        });
        return ok(JSON.stringify(result));
      } catch (e) {
        return fail(String(e));
      }
    },
  );

  server.registerTool(
    'fact_count',
    {
      description: 'Return the number of atomic facts currently stored in the vault.',
      inputSchema: {},
    },
    async () => {
      try {
        const facts = await readFacts();
        return ok(String(facts.length));
      } catch (e) {
        return fail(String(e));
      }
    },
  );

  server.registerTool(
    'fact_history',
    {
      description:
        'Return the audit journal for one fact (ADD/UPDATE/DELETE events, newest first).',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      try {
        const events = await readHistoryFor(id);
        return ok(JSON.stringify({ id, events }));
      } catch (e) {
        return fail(String(e));
      }
    },
  );

  return server;
}

export const mcpRouter = Router();

// Stateless: a fresh transport (and server connection) per request. The
// MCP-over-HTTP semantics don't need session state for our tool set —
// every call is a one-shot tool invocation.
mcpRouter.post('/', async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'mcp request failed');
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: null,
      });
    }
  }
});

// Stateless mode doesn't need GET (server-initiated streams) or DELETE
// (session termination), but clients may probe — return JSON-RPC errors
// that conform to MCP's transport expectations.
mcpRouter.get('/', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed (stateless mode).' },
    id: null,
  });
});

mcpRouter.delete('/', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed (stateless mode).' },
    id: null,
  });
});
