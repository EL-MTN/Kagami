import type { RequestHandler } from "express";

// Single-user localhost trust model. Echo any `*.localhost` origin (Portless
// gives every sibling its own subdomain) and allow the headers/methods the
// dashboard needs. Non-browser callers (shippers, curl) ignore these headers
// entirely, so wiring this universally on /v1 doesn't change non-CORS flows.
const LOCALHOST_ORIGIN = /^https?:\/\/(?:[\w-]+\.)*localhost(?::\d+)?$/;
const ALLOWED_HEADERS = "content-type, x-kansoku-auth, x-kansoku-dropped";
const ALLOWED_METHODS = "GET, POST, OPTIONS";

export const corsForDashboard: RequestHandler = (req, res, next) => {
  const origin = req.header("origin");
  if (origin && LOCALHOST_ORIGIN.test(origin)) {
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
