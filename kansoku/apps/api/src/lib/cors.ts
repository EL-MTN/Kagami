import type { RequestHandler } from "express";

// Single-user localhost trust model. We only echo origins that match one of
// the four Kagami dashboards (Kioku / Kizuna / Kokoro / Kansoku) — anything
// else (browser extension pages, miscellaneous *.localhost subdomains) gets
// no CORS response and the browser blocks the call. Non-browser callers
// (shippers, curl) ignore these headers entirely, so wiring this universally
// on /v1 doesn't change non-CORS flows.
const ALLOWED_ORIGINS = new Set([
  "https://kioku.localhost",
  "https://kizuna.localhost",
  "https://kokoro.localhost",
  "https://kansoku.localhost",
  // http variants in case Portless or a local proxy ever serves them.
  "http://kioku.localhost",
  "http://kizuna.localhost",
  "http://kokoro.localhost",
  "http://kansoku.localhost",
]);
const ALLOWED_HEADERS = "content-type, x-kansoku-auth, x-kansoku-dropped, traceparent";
const ALLOWED_METHODS = "GET, POST, OPTIONS";

export const corsForDashboard: RequestHandler = (req, res, next) => {
  const origin = req.header("origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
    res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
};
