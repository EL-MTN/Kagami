import { withTestDb } from "@kokoro/test-utils";
import { describe, expect, it } from "vitest";

import {
  SkillProposalDecision,
  isSkillRecentlyDeclined,
  recordSkillProposalDecision,
} from "../../src/models/skill-proposal";

withTestDb({ syncIndexes: false });

const CHAT = "chat-1";
const SIG = "meeting-followup-style#abcd1234";
const DAY_MS = 24 * 60 * 60 * 1000;

describe("recordSkillProposalDecision", () => {
  it("creates a declined row with denyCount=1 and a quiet window", async () => {
    const before = Date.now();
    await recordSkillProposalDecision(CHAT, SIG, "declined", { cooldownDays: 14 });

    const row = await SkillProposalDecision.findOne({ chatId: CHAT, signature: SIG });
    expect(row).not.toBeNull();
    expect(row!.verdict).toBe("declined");
    expect(row!.denyCount).toBe(1);
    const quietMs = row!.quietUntil.getTime() - before;
    expect(quietMs).toBeGreaterThan(14 * DAY_MS - 60_000);
    expect(quietMs).toBeLessThan(14 * DAY_MS + 60_000);
    expect(row!.expiresAt.getTime()).toBeGreaterThan(row!.quietUntil.getTime() + 60 * DAY_MS);
  });

  it("escalates repeat declines and keeps one row per chat/signature", async () => {
    await recordSkillProposalDecision(CHAT, SIG, "declined", { cooldownDays: 10 });
    await recordSkillProposalDecision(CHAT, SIG, "declined", { cooldownDays: 10 });

    const row = await SkillProposalDecision.findOne({ chatId: CHAT, signature: SIG });
    expect(row!.denyCount).toBe(2);
    const quietMs = row!.quietUntil.getTime() - Date.now();
    expect(quietMs).toBeGreaterThan(20 * DAY_MS - 60_000);
    expect(await SkillProposalDecision.countDocuments({ chatId: CHAT, signature: SIG })).toBe(1);
  });

  it("tracks independent signatures and chats", async () => {
    await recordSkillProposalDecision(CHAT, SIG, "declined");
    await recordSkillProposalDecision(CHAT, "other#0000", "declined");
    await recordSkillProposalDecision("chat-2", SIG, "declined");
    expect(await SkillProposalDecision.countDocuments({})).toBe(3);
  });

  it("accept preserves denyCount and suppresses while the row lives", async () => {
    await recordSkillProposalDecision(CHAT, SIG, "declined");
    await recordSkillProposalDecision(CHAT, SIG, "accepted");

    const row = await SkillProposalDecision.findOne({ chatId: CHAT, signature: SIG });
    expect(row!.verdict).toBe("accepted");
    expect(row!.denyCount).toBe(1);
    expect(await isSkillRecentlyDeclined(CHAT, SIG)).toBe(true);
  });
});

describe("isSkillRecentlyDeclined", () => {
  it("returns false without a row", async () => {
    expect(await isSkillRecentlyDeclined(CHAT, SIG)).toBe(false);
  });

  it("returns true inside the quiet window and false after it", async () => {
    await recordSkillProposalDecision(CHAT, SIG, "declined", { cooldownDays: 14 });
    expect(await isSkillRecentlyDeclined(CHAT, SIG)).toBe(true);

    await SkillProposalDecision.updateOne(
      { chatId: CHAT, signature: SIG },
      { quietUntil: new Date(Date.now() - 1000) },
    );
    expect(await isSkillRecentlyDeclined(CHAT, SIG)).toBe(false);
  });
});
