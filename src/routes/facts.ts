import { Router } from 'express';
import { z } from 'zod';
import { readFacts, type Fact } from '../storage/facts.js';
import { readHistoryFor } from '../storage/history.js';
import { appendFactsBulk, appendSingleFact } from '../ingest/append.js';

const AppendBody = z.object({
  text: z.string().min(1),
  event_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'event_date must be YYYY-MM-DD')
    .optional(),
  source_session: z.string().optional(),
  user_id: z.string().optional(),
  run_id: z.string().optional(),
  agent_id: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  category: z.string().optional(),
});

const ListQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'since must be YYYY-MM-DD')
    .optional(),
  until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'until must be YYYY-MM-DD')
    .optional(),
  source_session: z.string().optional(),
  user_id: z.string().optional(),
  run_id: z.string().optional(),
  agent_id: z.string().optional(),
});

// Drop the embedding from list/detail responses by default — embeddings
// are large (768 floats × 4 bytes printed = ~10KB per fact) and the only
// caller that needs them is the ranker, which projects them out of Mongo
// directly when scoring candidates.
function publicFact(f: Fact) {
  const { embedding: _embedding, ...rest } = f;
  void _embedding;
  return rest;
}

export const factsRouter = Router();

factsRouter.post('/', async (req, res, next) => {
  try {
    const body = AppendBody.parse(req.body);
    const result = await appendSingleFact(body);
    res.status(result.status === 'added' ? 201 : 200).json(result);
  } catch (err) {
    next(err);
  }
});

// Bulk infer=false add. Equivalent to mem0's `add([...], infer=False)`:
// each input is stored verbatim with its own dedup pass, no LLM
// extraction. Returns one result per input in order.
const BulkBody = z.object({
  facts: z.array(AppendBody).min(1).max(500),
});

factsRouter.post('/bulk', async (req, res, next) => {
  try {
    const body = BulkBody.parse(req.body);
    const results = await appendFactsBulk(body.facts);
    const added = results.filter((r) => r.status === 'added').length;
    const duplicates = results.length - added;
    res.status(201).json({ results, added, duplicates });
  } catch (err) {
    next(err);
  }
});

factsRouter.get('/count', async (_req, res, next) => {
  try {
    const facts = await readFacts();
    res.json({ count: facts.length });
  } catch (err) {
    next(err);
  }
});

factsRouter.get('/', async (req, res, next) => {
  try {
    const q = ListQuery.parse(req.query);
    const limit = q.limit ?? 100;
    const offset = q.offset ?? 0;

    let facts = await readFacts();
    if (q.since) facts = facts.filter((f) => f.event_date >= q.since!);
    if (q.until) facts = facts.filter((f) => f.event_date <= q.until!);
    if (q.source_session) {
      facts = facts.filter((f) => f.source_session === q.source_session);
    }
    if (q.user_id !== undefined) {
      facts = facts.filter((f) => f.user_id === q.user_id);
    }
    if (q.run_id !== undefined) {
      facts = facts.filter((f) => f.run_id === q.run_id);
    }
    if (q.agent_id !== undefined) {
      facts = facts.filter((f) => f.agent_id === q.agent_id);
    }
    facts.sort((a, b) =>
      (b.event_date || '').localeCompare(a.event_date || '') ||
      b.created_at.localeCompare(a.created_at),
    );
    const total = facts.length;
    const page = facts.slice(offset, offset + limit).map(publicFact);
    res.json({ total, limit, offset, facts: page });
  } catch (err) {
    next(err);
  }
});

factsRouter.get('/:id/history', async (req, res, next) => {
  try {
    const events = await readHistoryFor(req.params.id);
    res.json({ id: req.params.id, events });
  } catch (err) {
    next(err);
  }
});

factsRouter.get('/:id', async (req, res, next) => {
  try {
    const facts = await readFacts();
    const f = facts.find((x) => x.id === req.params.id);
    if (!f) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(publicFact(f));
  } catch (err) {
    next(err);
  }
});
