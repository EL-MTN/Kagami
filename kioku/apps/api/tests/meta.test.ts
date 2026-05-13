import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, expect, it } from "vitest";
import { KIOKU_CATEGORIES } from "../src/ingest/categories.ts";
import { metaRouter } from "../src/routes/meta.ts";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use("/", metaRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test server did not bind to a port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
});

it("GET /meta/categories returns the supported Kioku categories", async () => {
  const res = await fetch(`${baseUrl}/meta/categories`);

  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toEqual({ categories: KIOKU_CATEGORIES });
});
