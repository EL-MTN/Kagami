import { expect, it } from "vitest";
import { isLowValueFact, filterDurableFacts } from "../src/ingest/relevance.ts";

// Observed casual-companion-chat junk from the live store audits — every
// one of these must be dropped.
const DROP = [
  "Assistant felt happy to have remembered the user's birthday correctly and expressed gratitude to Goshujin-sama for the acknowledgment.",
  "Shiro responded to the user's message with 'miss you too Goshujin-sama ❤️' during their conversation on May 17, 2026, showing mutual affection.",
  "User, referred to as Goshujin-sama, greeted Shiro affectionately with 'Shiro~' during their conversation on May 17, 2026.",
  "User expressed affection by saying they missed Shiro during their conversation on May 17, 2026, indicating a close relationship.",
  "User, referred to as Goshujin-sama, engaged in a playful exchange with Shiro, expressing a sense of closeness and affection on May 17, 2026.",
  "User confirmed that everything is good during the conversation on May 15, 2026.",
  "User expressed satisfaction by saying 'Yep! Good girl' in response to the assistant's memory recall.",
  "User, referred to as Goshujin-sama, repeated the name 'Shiro' in a friendly manner on May 17, 2026.",
  "User greeted Shiro with 'Good morning~' during their conversation on May 17, 2026, indicating a friendly and affectionate tone.",
  "User inquired if the assistant could use its memory tool during the conversation on May 15, 2026.",
  "User expressed missing Shiro with a heart emoji ❤️ on May 17, 2026.",
];

// Benchmark-safety contract: LongMemEval-style task facts + the real
// task facts from this deployment's transcripts. NONE may be dropped —
// a regression here is lost recall on the retrieval benchmark.
const KEEP = [
  "User's name is Marcus and was promoted to Senior Engineer at Shopify around August 12, 2025 after working toward it for two years",
  "Marcus has a wife named Elena and they celebrate special occasions at Osteria Francescana, their go-to restaurant",
  "Marcus and his wife Elena are expecting their first baby in March 2026",
  "User went to Paris the week of May 15, 2023",
  "User's D&D campaign encounter includes 4 Mummies (AC 11, 45 HP, Speed 20 ft) with Curse of the Pharaohs (DC 15 Wisdom save)",
  "User listened to the Ready Player One audiobook around early January 2022 and enjoyed the pop culture references",
  "User was recommended 'Marriage Story' and 'The Irishman' for performance study, and Helen Mirren's MasterClass for acting techniques",
  "Bajimaya v Reward Homes Pty Ltd: construction began in 2014, contract signed in 2015, completion due by October 2015",
  "User switched from almond milk to oat milk lattes after developing an almond sensitivity",
  "User's birthday is April 11.",
  "User, referred to as Goshujin-sama, requested the creation of a routine to fetch the total return on their Robinhood portfolio daily at 7 AM on weekdays.",
  "User asked the assistant to log into Robinhood for them, noting that there are autofilled passwords available for the login process.",
  "User requested assistance in finding recent trends related to selling put options for Tesla (TSLA).",
  "User is currently in California and noted that it is 11 PM on May 15, 2026.",
];

it("drops observed casual-chat / assistant-narration junk", () => {
  for (const t of DROP) {
    expect(isLowValueFact(t), `should DROP: ${t}`).toBe(true);
  }
});

it("keeps LongMemEval-style and task facts (benchmark-safety contract)", () => {
  for (const t of KEEP) {
    expect(isLowValueFact(t), `should KEEP: ${t}`).toBe(false);
  }
});

it("filterDurableFacts partitions and preserves order", () => {
  const mems = [
    { id: "0", text: KEEP[0]! },
    { id: "1", text: DROP[0]! },
    { id: "2", text: KEEP[1]! },
  ];
  const { kept, dropped } = filterDurableFacts(mems);
  expect(kept.map((m) => m.id)).toEqual(["0", "2"]);
  expect(dropped.map((m) => m.id)).toEqual(["1"]);
});

it("treats empty / whitespace text as low-value", () => {
  expect(isLowValueFact("")).toBe(true);
  expect(isLowValueFact("   \n  ")).toBe(true);
});
