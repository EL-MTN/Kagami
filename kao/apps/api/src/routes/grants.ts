import { Router } from "express";
import type { Db } from "mongodb";
import type { Config } from "../config.js";
import { GRANT_NAMES, isGrantName, scopesFor } from "../grant-registry.js";
import { errors } from "../lib/errors.js";
import { decrypt } from "../lib/encryption.js";
import {
  OAuthError,
  clearAccessTokenCache,
  refreshAccessToken,
  revokeAtGoogle,
} from "../lib/google.js";
import { getGrant, listGrants, revokeGrant } from "../storage/grants.js";

interface GrantStatus {
  name: string;
  scopes: string[];
  granted: boolean;
  grantedAt: Date | null;
  revokedAt: Date | null;
}

// Everything under here is mounted behind requireBearer (see server.ts).
export function makeGrantsRouter(config: Config, db: Db): Router {
  const r = Router();

  // List status for every registry grant — registry-driven so a never-yet-
  // consented grant still shows up as granted:false.
  r.get("/", async (_req, res) => {
    const rows = await listGrants(db);
    const byName = new Map(rows.map((g) => [g.name, g]));
    const statuses: GrantStatus[] = GRANT_NAMES.map((name) => {
      const row = byName.get(name);
      return {
        name,
        scopes: scopesFor(name),
        granted: Boolean(row && row.refreshToken && !row.revokedAt),
        grantedAt: row?.grantedAt ?? null,
        revokedAt: row?.revokedAt ?? null,
      };
    });
    res.json({ grants: statuses });
  });

  r.get("/:grant", async (req, res) => {
    const grant = req.params.grant;
    if (!isGrantName(grant)) {
      throw errors.notFound(`unknown grant '${grant}'`);
    }
    const row = await getGrant(db, grant);
    const status: GrantStatus = {
      name: grant,
      scopes: scopesFor(grant),
      granted: Boolean(row && row.refreshToken && !row.revokedAt),
      grantedAt: row?.grantedAt ?? null,
      revokedAt: row?.revokedAt ?? null,
    };
    res.json(status);
  });

  // The hot path: vend a fresh access token for the grant. Structured codes
  // let a caller distinguish "never consented / revoked" (409 no_grant),
  // "Google rejected the refresh — operator must re-consent" (409
  // invalid_grant), and a transient refresh failure (502).
  r.get("/:grant/token", async (req, res) => {
    const grant = req.params.grant;
    if (!isGrantName(grant)) {
      throw errors.notFound(`unknown grant '${grant}'`);
    }
    const row = await getGrant(db, grant);
    if (!row || !row.refreshToken || row.revokedAt) {
      throw errors.conflict(`no active grant for '${grant}'`, { code: "no_grant" });
    }
    const refresh = decrypt(row.refreshToken, config.KAO_ENCRYPTION_KEY);
    try {
      const vended = await refreshAccessToken(config, grant, refresh);
      res.json({
        accessToken: vended.accessToken,
        expiresAt: vended.expiresAt,
        scopes: scopesFor(grant),
      });
    } catch (err) {
      if (err instanceof OAuthError) {
        if (err.code === "invalid_grant") {
          throw errors.conflict(err.message, { code: "invalid_grant" });
        }
        throw errors.badGateway(err.message);
      }
      throw err;
    }
  });

  // Revoke: best-effort at Google, then drop the local secret regardless so
  // the token stops being vendable immediately.
  r.delete("/:grant", async (req, res) => {
    const grant = req.params.grant;
    if (!isGrantName(grant)) {
      throw errors.notFound(`unknown grant '${grant}'`);
    }
    const row = await getGrant(db, grant);
    if (row?.refreshToken) {
      try {
        await revokeAtGoogle(config, decrypt(row.refreshToken, config.KAO_ENCRYPTION_KEY));
      } catch {
        // decrypt failure (e.g. rotated key) — still drop the row below.
      }
    }
    await revokeGrant(db, grant);
    clearAccessTokenCache(grant);
    res.json({ revoked: true, grant });
  });

  return r;
}
