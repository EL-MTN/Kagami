import { expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTranscript } from "../src/ingest/transcript.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, "fixtures/transcript-1.md");

it("parses frontmatter", async () => {
  const t = await readTranscript(fixture);
  expect(t.frontmatter.id).toBe("2026-04-27-1430");
  expect(t.frontmatter.started_at).toBe("2026-04-27T14:30:00.000Z");
});

it("parses every turn", async () => {
  const t = await readTranscript(fixture);
  expect(t.turns.length).toBe(5);
  expect(t.turns[0]!.id).toBe("t-0001");
  expect(t.turns[0]!.role).toBe("user");
  expect(t.turns[0]!.text).toMatch(/coffee with Alex Smith/);
  expect(t.turns[4]!.id).toBe("t-0005");
  expect(t.turns[4]!.text).toMatch(/skew shorter/);
});

it("turn text excludes the heading line", async () => {
  const t = await readTranscript(fixture);
  for (const turn of t.turns) {
    expect(turn.text).not.toMatch(/^##\s+t-/m);
  }
});
