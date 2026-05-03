import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { errors } from './errors.js';

export type AuthContext = {
  source: 'concierge';
};

declare module 'express-serve-static-core' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Request {
    auth?: AuthContext;
  }
}

export function bearerAuth(apiKey: string): RequestHandler {
  const expected = Buffer.from(apiKey, 'utf8');
  return (req, _res, next) => {
    const header = req.header('authorization');
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      next(errors.unauthorized('missing bearer token'));
      return;
    }
    const token = header.slice(7).trim();
    const provided = Buffer.from(token, 'utf8');
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      next(errors.unauthorized('invalid bearer token'));
      return;
    }
    req.auth = { source: 'concierge' };
    next();
  };
}
