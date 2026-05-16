import { afterAll, beforeAll, expect, it } from "vitest";

// The distinct-tuple budget is read once at module load from
// KANSOKU_MAX_META_COMBOS, so set it before the dynamic import. No Mongo
// needed — guardMeta is pure except for its in-process budget set.

type Guard = typeof import("../src/lib/cardinality.ts");
let mod: Guard;
let savedEnv: string | undefined;

beforeAll(async () => {
  savedEnv = process.env.KANSOKU_MAX_META_COMBOS;
  process.env.KANSOKU_MAX_META_COMBOS = "2";
  mod = await import("../src/lib/cardinality.ts");
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env.KANSOKU_MAX_META_COMBOS;
  else process.env.KANSOKU_MAX_META_COMBOS = savedEnv;
});

it("passes tuples through until the budget is exhausted, then collapses to a sentinel", () => {
  mod.__resetCardinalityGuardForTests();
  const { guardMeta, cardinalityStats } = mod;

  const a = guardMeta({ service: "s1", component: "c1", env: "prod", level: "info" });
  const b = guardMeta({ service: "s2", component: "c2", env: "prod", level: "info" });
  expect(a).toEqual({ service: "s1", component: "c1", env: "prod", level: "info" });
  expect(b).toEqual({ service: "s2", component: "c2", env: "prod", level: "info" });
  expect(cardinalityStats()).toMatchObject({ distinct: 2, budget: 2, coercedTotal: 0 });

  // Budget (2) exhausted — a third *distinct* tuple collapses, level kept.
  const c = guardMeta({ service: "s3", component: "c3", env: "prod", level: "error" });
  expect(c).toEqual({
    service: "_over_cardinality_budget",
    component: "_over_cardinality_budget",
    env: "_over_cardinality_budget",
    level: "error",
  });
  expect(cardinalityStats().coercedTotal).toBe(1);
});

it("still admits an already-seen tuple after the budget is exhausted", () => {
  mod.__resetCardinalityGuardForTests();
  const { guardMeta } = mod;

  guardMeta({ service: "s1", component: "c1", env: "prod", level: "info" });
  guardMeta({ service: "s2", component: "c2", env: "prod", level: "info" });
  guardMeta({ service: "s3", component: "c3", env: "prod", level: "info" }); // collapsed

  // The two admitted tuples keep passing through unchanged.
  const again = guardMeta({ service: "s1", component: "c1", env: "prod", level: "info" });
  expect(again).toEqual({ service: "s1", component: "c1", env: "prod", level: "info" });
});
