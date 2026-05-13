# API

Two surfaces, same operations:

- **REST** at `https://api.kioku.localhost` (Portless) — bot- and dashboard-friendly.
- **MCP** at `POST https://api.kioku.localhost/mcp` (streamable HTTP transport) — Claude Desktop / agent-friendly.

The bot (Kokoro) uses REST directly; external agents typically use MCP.

## REST

Routers in `apps/api/src/routes/*` are mounted in `server.ts`:

```ts
app.use("/", metaRouter);
app.use("/facts", factsRouter);
app.use("/recall", recallRouter);
app.use("/query", queryRouter);
app.use("/sessions", sessionsRouter);
app.use("/mcp", mcpRouter);
```

### Conventions

- All request bodies parsed via zod. Validation failures → `400 { error: "validation_error", issues }` from the global error handler.
- Other unhandled errors → `500 { error: "internal_error" }` with a logged `req.log.error`.
- `express.json({ limit: "10mb" })` because transcripts can be sizeable.
- `pino-http` middleware tags every request with a `req.log`.
- Public fact responses strip the `embedding` field — only the in-process ranker reads it (projects directly from Mongo).

### Endpoint reference

| Method | Path                 | Body / Query                                                                                   | Response                                                                                                                                           |
| ------ | -------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`            | —                                                                                              | `{ ok: true }`                                                                                                                                     |
| GET    | `/version`           | —                                                                                              | `{ name: "kioku", version }` (read from `apps/api/package.json`, cached)                                                                           |
| GET    | `/meta/categories`   | —                                                                                              | `{ categories: string[] }` — supported category tags emitted by the extraction pipeline                                                            |
| POST   | `/facts`             | `{ text, event_date?, source_session?, user_id?, run_id?, agent_id?, metadata?, category? }`   | `201 { id, status: "added" }` or `200 { id, status: "duplicate", similarity }`                                                                     |
| POST   | `/facts/bulk`        | `{ facts: AppendBody[] }` (1–500)                                                              | `201 { results, added, duplicates }`                                                                                                               |
| GET    | `/facts/count`       | —                                                                                              | `{ count }`                                                                                                                                        |
| GET    | `/facts`             | `?limit=100&offset=0&since=YYYY-MM-DD&until=YYYY-MM-DD&source_session&user_id&run_id&agent_id` | `{ total, limit, offset, facts: PublicFact[] }` (`embedding` stripped, sorted newest event_date first)                                             |
| GET    | `/facts/:id`         | —                                                                                              | `PublicFact` or `404 { error: "not_found" }`                                                                                                       |
| GET    | `/facts/:id/history` | —                                                                                              | `{ id, events: HistoryEvent[] }` (newest first; today only ADD events are written)                                                                 |
| POST   | `/recall`            | `{ query, k?, since?, until?, filters? }`                                                      | `{ facts: RecalledFact[], total }`                                                                                                                 |
| POST   | `/query`             | `{ question, k?, filters? }`                                                                   | `{ answer, citations: string[] }` — citations are the deduped source session ids of the top-K retrieved facts (rank order, `raw/` prefix stripped) |
| POST   | `/sessions`          | `{ transcript, user_id?, run_id?, agent_id?, metadata? }`                                      | `201 { sessionId, added, batches }`                                                                                                                |

`AppendBody` shape (from `apps/api/src/routes/facts.ts`):

```ts
{
  text: string                            // min length 1
  event_date?: "YYYY-MM-DD"
  source_session?: string
  user_id?: string                        // defaults to 'default' at the writer
  run_id?: string
  agent_id?: string
  metadata?: Record<string, unknown>
  category?: string
}
```

`MemoryFilters` shape (from `apps/api/src/routes/filters.ts`):

```ts
{
  user_id?: string
  run_id?: string
  agent_id?: string
  category?: string
  metadata?: Record<string, string | number | boolean>
}
```

`RecalledFact` shape (`apps/api/src/query/recall.ts`):

```ts
interface RecalledFact {
  id: string;
  text: string;
  event_date: string;
  source_session: string;
  created_at: string;
}
```

### Recall semantics

- Default `k = 10`.
- When `since` or `until` is set, the ranker over-fetches by `max(k * 3, 30)` to absorb the post-filter loss; the date window is then applied to the ranked results and the top-K is sliced.
- `filters` is pushed down to `$vectorSearch` and `$search` for declared fields (`user_id`, `run_id`, `agent_id`, `category`); `metadata.<key>` filters apply post-`$in` via Mongo `$match`.
- Failure of the ranker is logged but not raised — `query` returns an "(empty answer)" / "(no answer — query failed: …)" string; `recall` propagates the error.

See [retrieval.md](retrieval.md) for the ranking formula.

## MCP

`apps/api/src/mcp.ts` mounts a streamable-HTTP MCP transport at `POST /mcp`. **Stateless** — a fresh transport + server connection per request. The MCP-over-HTTP semantics don't need session state for our tool set: every call is a one-shot tool invocation.

`GET /mcp` and `DELETE /mcp` return `405 Method not allowed (stateless mode)` JSON-RPC errors.

### Tools

| Tool             | Inputs                                                                                       | Returns                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `recall`         | `{ query, k?, since?, until?, filters? }`                                                    | `{ facts, total }` — same shape as `POST /recall`, JSON-stringified into a text content block.                                       |
| `query`          | `{ question, filters? }`                                                                     | `{ answer, citations }` — same as `POST /query`. Use this when you want a synthesized answer; use `recall` for raw facts.            |
| `append_fact`    | `{ text, event_date?, source_session?, user_id?, run_id?, agent_id?, metadata?, category? }` | `{ id, status: "added" \| "duplicate", reason?, similarity? }`                                                                       |
| `append_facts`   | `{ facts: AppendBody[] }` (1–500)                                                            | `{ results, added, duplicates }`. Equivalent to mem0 `add(infer=False)` — store N caller-supplied facts verbatim, no LLM extraction. |
| `ingest_session` | `{ transcript, user_id?, run_id?, agent_id?, metadata? }`                                    | `{ sessionId, added, batches }`                                                                                                      |
| `fact_count`     | `{}`                                                                                         | The integer count, as a string in the text content block.                                                                            |
| `fact_history`   | `{ id }`                                                                                     | `{ id, events }`                                                                                                                     |

All tools return their payload as a single text content block (`{ content: [{ type: "text", text: JSON.stringify(...) }] }`). Errors return `isError: true`.

### When to use which

- Use `recall` when you want raw fact retrieval and will reason over the results yourself in a parent prompt.
- Use `query` when you want a synthesized answer in one round-trip.
- Use `append_fact` when the LLM is confident about a single fact (the tool LLM in Kokoro uses this).
- Use `append_facts` when you have a bulk import (e.g., backfill from another store).
- Use `ingest_session` when you have a full transcript that needs LLM extraction.

## Inter-service config

Default Kioku URL across the Kagami workspace:

| Caller                            | Env var         | Default                       |
| --------------------------------- | --------------- | ----------------------------- |
| Kokoro bot                        | `KIOKU_URL`     | `https://api.kioku.localhost` |
| Kioku dashboard                   | `KIOKU_API_URL` | `https://api.kioku.localhost` |
| Standalone fallback (no Portless) | —               | `http://localhost:7777`       |

The standalone-fallback port (`7777`) only matters when running the API outside Portless; under `npm run dev`, Portless picks an ephemeral port and routes `https://api.kioku.localhost` to it.
