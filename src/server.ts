import 'dotenv/config';
import express, { type ErrorRequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import { ZodError } from 'zod';
import { logger } from './logger.js';
import { metaRouter } from './routes/meta.js';
import { factsRouter } from './routes/facts.js';
import { recallRouter } from './routes/recall.js';
import { queryRouter } from './routes/query.js';
import { sessionsRouter } from './routes/sessions.js';
import { mcpRouter } from './mcp.js';

const PORT = Number.parseInt(process.env.KIOKU_PORT ?? '7777', 10);
const HOST = process.env.KIOKU_HOST ?? '127.0.0.1';

const app = express();

// Transcripts can be sizeable; bump beyond the 100kb default.
app.use(express.json({ limit: '10mb' }));
app.use(pinoHttp({ logger }));

app.use('/', metaRouter);
app.use('/facts', factsRouter);
app.use('/recall', recallRouter);
app.use('/query', queryRouter);
app.use('/sessions', sessionsRouter);
app.use('/mcp', mcpRouter);

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'validation_error', issues: err.issues });
    return;
  }
  req.log.error({ err: (err as Error).message }, 'unhandled request error');
  if (!res.headersSent) {
    res.status(500).json({ error: 'internal_error' });
  }
};
app.use(errorHandler);

app.listen(PORT, HOST, () => {
  logger.info({ host: HOST, port: PORT }, 'kioku http server listening');
});
