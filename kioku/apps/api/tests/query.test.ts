import { expect, it } from "vitest";
import {
  deriveQuestionDate,
  extractCitations,
  formatFactsGroupedByDateNewestFirst,
  stripMemThinking,
} from "../src/query/answer.ts";
import { computeCitationRecall } from "../scripts/citation-recall.ts";
import type { RankedFact } from "../src/retrieval/embeddings.ts";

const fact = (overrides: Partial<RankedFact>): RankedFact => ({
  id: "id",
  text: "placeholder",
  eventDate: "2024-01-01",
  sourceSession: "raw/s",
  createdAt: "2024-01-01T00:00:00Z",
  ...overrides,
});

it("formatFactsGroupedByDateNewestFirst groups by date, newest first", () => {
  const facts: RankedFact[] = [
    fact({ id: "a", text: "first", eventDate: "2024-03-01" }),
    fact({ id: "b", text: "middle", eventDate: "2024-02-01" }),
    fact({ id: "c", text: "second-on-march", eventDate: "2024-03-01" }),
  ];
  const out = formatFactsGroupedByDateNewestFirst(facts);
  expect(out).toBe(
    "--- 2024-03-01 ---\n- first\n- second-on-march\n\n--- 2024-02-01 ---\n- middle",
  );
});

it("formatFactsGroupedByDateNewestFirst falls back to createdAt date when eventDate empty", () => {
  const facts: RankedFact[] = [
    fact({ id: "a", text: "t1", eventDate: "", createdAt: "2024-05-04T10:00:00Z" }),
  ];
  expect(formatFactsGroupedByDateNewestFirst(facts)).toBe("--- 2024-05-04 ---\n- t1");
});

it("formatFactsGroupedByDateNewestFirst on empty input returns empty string", () => {
  expect(formatFactsGroupedByDateNewestFirst([])).toBe("");
});

it("stripMemThinking removes the thinking block and leading punctuation", () => {
  const raw = "<mem_thinking>scratch work...</mem_thinking>\n: The answer is 42";
  expect(stripMemThinking(raw)).toBe("The answer is 42");
});

it("stripMemThinking is a no-op when no thinking block", () => {
  expect(stripMemThinking("plain answer")).toBe("plain answer");
});

it("stripMemThinking handles multiple thinking blocks", () => {
  const raw = "<mem_thinking>a</mem_thinking>middle<mem_thinking>b</mem_thinking>tail";
  expect(stripMemThinking(raw)).toBe("middletail");
});

it("deriveQuestionDate returns max eventDate from facts", () => {
  const facts: RankedFact[] = [
    fact({ eventDate: "2023-01-15" }),
    fact({ eventDate: "2024-06-20" }),
    fact({ eventDate: "2023-11-30" }),
  ];
  expect(deriveQuestionDate(facts)).toBe("2024-06-20");
});

it("deriveQuestionDate falls back to wall clock on empty facts", () => {
  const today = new Date().toISOString().slice(0, 10);
  expect(deriveQuestionDate([])).toBe(today);
});

it("deriveQuestionDate uses createdAt when eventDate is empty", () => {
  const facts: RankedFact[] = [fact({ eventDate: "", createdAt: "2025-04-01T00:00:00Z" })];
  expect(deriveQuestionDate(facts)).toBe("2025-04-01");
});

it("extractCitations strips raw/ prefix and preserves rank order", () => {
  const facts: RankedFact[] = [
    fact({ id: "a", sourceSession: "raw/sess-z" }),
    fact({ id: "b", sourceSession: "raw/sess-a" }),
    fact({ id: "c", sourceSession: "raw/sess-m" }),
  ];
  expect(extractCitations(facts)).toEqual(["sess-z", "sess-a", "sess-m"]);
});

it("extractCitations dedupes multiple facts from the same session", () => {
  const facts: RankedFact[] = [
    fact({ id: "a", sourceSession: "raw/sess-1" }),
    fact({ id: "b", sourceSession: "raw/sess-2" }),
    fact({ id: "c", sourceSession: "raw/sess-1" }),
    fact({ id: "d", sourceSession: "raw/sess-2" }),
  ];
  expect(extractCitations(facts)).toEqual(["sess-1", "sess-2"]);
});

it("extractCitations drops empty sourceSession", () => {
  const facts: RankedFact[] = [
    fact({ id: "a", sourceSession: "raw/sess-1" }),
    fact({ id: "b", sourceSession: "" }),
    fact({ id: "c", sourceSession: "raw/sess-2" }),
  ];
  expect(extractCitations(facts)).toEqual(["sess-1", "sess-2"]);
});

it("extractCitations passes through ids that lack the raw/ prefix", () => {
  // appendSingleFact lets callers supply arbitrary source_session
  // values — the prefix isn't guaranteed and shouldn't be required.
  const facts: RankedFact[] = [
    fact({ id: "a", sourceSession: "telegram-12345" }),
    fact({ id: "b", sourceSession: "raw/sess-1" }),
  ];
  expect(extractCitations(facts)).toEqual(["telegram-12345", "sess-1"]);
});

it("extractCitations only strips the leading raw/, not mid-string occurrences", () => {
  const facts: RankedFact[] = [fact({ id: "a", sourceSession: "raw/raw/odd" })];
  expect(extractCitations(facts)).toEqual(["raw/odd"]);
});

it("extractCitations on empty input returns empty array", () => {
  expect(extractCitations([])).toEqual([]);
});

it("computeCitationRecall returns 1.0 when every truth id is cited", () => {
  expect(computeCitationRecall(["a", "b", "c"], ["a", "b"])).toBe(1);
});

it("computeCitationRecall returns hit/total", () => {
  expect(computeCitationRecall(["a", "x"], ["a", "b", "c", "d"])).toBe(0.25);
});

it("computeCitationRecall returns 0 when no truth ids are cited", () => {
  expect(computeCitationRecall(["x", "y"], ["a", "b"])).toBe(0);
});

it("computeCitationRecall is undefined when truth is missing or empty", () => {
  expect(computeCitationRecall(["a"], undefined)).toBeUndefined();
  expect(computeCitationRecall(["a"], [])).toBeUndefined();
});

it("computeCitationRecall ignores duplicates in the predicted citations", () => {
  // citations come from extractCitations which dedupes, but the
  // function shouldn't depend on that invariant.
  expect(computeCitationRecall(["a", "a", "a"], ["a", "b"])).toBe(0.5);
});
