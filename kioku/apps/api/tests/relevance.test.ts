import { expect, it } from "vitest";
import { filterDurableFacts } from "../src/ingest/relevance.ts";

// The relevance pass is an LLM classifier — its judgment can't be
// statically asserted (that is what the LongMemEval battery is for) and,
// per the session-summary.test.ts convention, the harness has no model
// wired so we don't invoke it here. This covers the one deterministic
// guarantee: the non-LLM short-circuit. Fail-open on classifier error is
// implemented (catch → keep all) and exercised end-to-end by the battery.

it("short-circuits empty input without an LLM call", async () => {
  const out = await filterDurableFacts([]);
  expect(out.kept).toEqual([]);
  expect(out.dropped).toEqual([]);
});
