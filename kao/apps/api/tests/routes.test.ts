import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { loadConfig, type Config } from "../src/config.js";
import { createApp } from "../src/server.js";
import { closeMongo, connectMongo } from "../src/storage/mongo.js";
import { ensureGrantIndexes } from "../src/storage/grants.js";
import { SHARED_MONGO_URI_ENV } from "./global-setup.js";

const TOKEN = "test-bearer-token-aaaaaaaaaaaa";
let app: Express;
let config: Config;

beforeAll(async () => {
  const uri = process.env[SHARED_MONGO_URI_ENV];
  if (!uri) throw new Error("shared mongo URI not set by global-setup");
  config = loadConfig({
    MONGODB_URI: uri,
    KAO_DB_NAME: "kao_test",
    GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
    KAO_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
    KAO_TOKEN: TOKEN,
  });
  const db = await connectMongo(config);
  await ensureGrantIndexes(db);
  app = createApp({ db, config });
});

afterAll(async () => {
  await closeMongo();
});

const auth = { Authorization: `Bearer ${TOKEN}` };

describe("open routes", () => {
  it("GET /healthz is open and OK", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET / renders the operator grants page", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("kizuna");
    expect(res.text).toContain("kokoro");
    expect(res.text).toContain("not granted");
  });

  it("GET /oauth/:grant/start redirects to Google with the registry scopes", async () => {
    const res = await request(app).get("/oauth/kizuna/start");
    expect(res.status).toBe(302);
    const loc = res.headers.location ?? "";
    expect(loc).toContain("accounts.google.com");
    expect(decodeURIComponent(loc)).toContain("https://www.googleapis.com/auth/gmail.readonly");
    // kizuna is read-only — the send scope must not be requested.
    expect(decodeURIComponent(loc)).not.toContain("https://www.googleapis.com/auth/gmail.send");
  });

  it("GET /oauth/:unknown/start is 404", async () => {
    expect((await request(app).get("/oauth/kioku/start")).status).toBe(404);
  });

  it("GET /oauth/callback rejects missing code/state and bad state", async () => {
    expect((await request(app).get("/oauth/callback")).status).toBe(400);
    expect(
      (await request(app).get("/oauth/callback").query({ code: "c", state: "bad" })).status,
    ).toBe(401);
  });
});

describe("vend surface is bearer-gated", () => {
  it("GET /grants without a bearer is 401", async () => {
    expect((await request(app).get("/grants")).status).toBe(401);
  });

  it("GET /grants with a wrong bearer is 401", async () => {
    const res = await request(app).get("/grants").set("Authorization", "Bearer nope");
    expect(res.status).toBe(401);
  });

  it("GET /grants with the bearer lists registry grants as not-granted", async () => {
    const res = await request(app).get("/grants").set(auth);
    expect(res.status).toBe(200);
    const names = (res.body.grants as { name: string; granted: boolean }[])
      .map((g) => g.name)
      .sort();
    expect(names).toEqual(["kizuna", "kokoro"]);
    expect(res.body.grants.every((g: { granted: boolean }) => g.granted === false)).toBe(true);
  });

  it("GET /grants/:unknown is 404", async () => {
    expect((await request(app).get("/grants/kioku").set(auth)).status).toBe(404);
  });

  it("GET /grants/:grant/token with no grant on file is 409 no_grant", async () => {
    const res = await request(app).get("/grants/kizuna/token").set(auth);
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ code: "no_grant" });
  });

  it("DELETE /grants/:grant is idempotent when nothing is on file", async () => {
    const res = await request(app).delete("/grants/kokoro").set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: true, grant: "kokoro" });
  });
});
