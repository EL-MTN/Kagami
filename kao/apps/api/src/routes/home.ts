import { Router } from "express";
import type { Db } from "mongodb";
import { GRANT_NAMES, scopesFor } from "../grant-registry.js";
import { listGrants } from "../storage/grants.js";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

// Minimal operator surface, served as inline HTML from the API — same pattern
// as the OAuth callback's inline page (Kizuna does this too). The full
// Next.js dashboard is deliberately deferred for the standalone Kao pass.
// Open at localhost: it triggers the consent flow, holds no secret, and the
// vend surface it links to is bearer-gated.
export function homeRouter(db: Db): Router {
  const r = Router();
  r.get("/", async (_req, res) => {
    const rows = await listGrants(db);
    const byName = new Map(rows.map((g) => [g.name, g]));
    const items = GRANT_NAMES.map((name) => {
      const row = byName.get(name);
      const granted = Boolean(row && row.refreshToken && !row.revokedAt);
      const badge = granted
        ? '<span style="color:#15803d">● granted</span>'
        : '<span style="color:#b91c1c">● not granted</span>';
      const when = row?.grantedAt
        ? ` <small style="color:#71717a">since ${esc(row.grantedAt.toISOString())}</small>`
        : "";
      const scopeList = scopesFor(name)
        .map((s) => `<li><code>${esc(s)}</code></li>`)
        .join("");
      return (
        `<section style="margin:1.25rem 0;padding:1rem 1.25rem;border:1px solid #e4e4e7;border-radius:10px">` +
        `<h2 style="margin:0 0 .25rem;font-size:1.1rem;font-weight:600">${esc(name)} ${badge}${when}</h2>` +
        `<ul style="margin:.5rem 0;color:#52525b;font-size:.85rem">${scopeList}</ul>` +
        `<a href="/oauth/${esc(name)}/start" ` +
        `style="display:inline-block;margin-top:.25rem;padding:.4rem .8rem;` +
        `background:#18181b;color:#fff;border-radius:7px;text-decoration:none;font-size:.85rem">` +
        `${granted ? "Re-consent" : "Connect Google"}</a>` +
        `</section>`
      );
    }).join("");

    res
      .status(200)
      .type("text/html")
      .send(
        '<!doctype html><meta charset="utf-8"><title>Kao — grants</title>' +
          '<body style="font-family:system-ui;max-width:640px;margin:3rem auto;padding:0 1.25rem;color:#18181b">' +
          '<h1 style="font-weight:600">Kao</h1>' +
          '<p style="color:#52525b">Per-consumer Google OAuth grants. Each is consented for only the scopes that consumer needs.</p>' +
          items +
          "</body>",
      );
  });
  return r;
}
