import { withTestDb } from "@kokoro/test-utils";
import { describe, expect, it } from "vitest";

import {
  RoutineProposalDecision,
  recordProposalDecision,
  isRecentlyDeclined,
} from "../../src/models/routine-proposal";

withTestDb({ syncIndexes: false });

const CHAT = "chat-1";
const SIG = "morning-digest#abcd1234";
const DAY_MS = 24 * 60 * 60 * 1000;

describe("recordProposalDecision", () => {
  it("creates a declined row with denyCount=1 and a quiet window ~ base cooldown", async () => {
    const before = Date.now();
    await recordProposalDecision(CHAT, SIG, "declined", { cooldownDays: 14 });

    const row = await RoutineProposalDecision.findOne({ chatId: CHAT, signature: SIG });
    expect(row).not.toBeNull();
    expect(row!.verdict).toBe("declined");
    expect(row!.denyCount).toBe(1);
    // quietUntil ≈ now + 14d (± 1 min tolerance).
    const quietMs = row!.quietUntil.getTime() - before;
    expect(quietMs).toBeGreaterThan(14 * DAY_MS - 60_000);
    expect(quietMs).toBeLessThan(14 * DAY_MS + 60_000);
    // expiresAt (TTL) is well past quietUntil so escalation history survives.
    expect(row!.expiresAt.getTime()).toBeGreaterThan(row!.quietUntil.getTime() + 60 * DAY_MS);
  });

  it("escalates the quiet window on repeat declines (denyCount drives it)", async () => {
    await recordProposalDecision(CHAT, SIG, "declined", { cooldownDays: 10 });
    await recordProposalDecision(CHAT, SIG, "declined", { cooldownDays: 10 });

    const row = await RoutineProposalDecision.findOne({ chatId: CHAT, signature: SIG });
    expect(row!.denyCount).toBe(2);
    // Second decline → 2 × 10 = 20 days.
    const quietMs = row!.quietUntil.getTime() - Date.now();
    expect(quietMs).toBeGreaterThan(20 * DAY_MS - 60_000);
    expect(quietMs).toBeLessThan(20 * DAY_MS + 60_000);
  });

  it("caps the escalating cooldown at 365 days", async () => {
    // base 100d × denyCount 5 = 500d, clamped to 365.
    for (let i = 0; i < 5; i++) {
      await recordProposalDecision(CHAT, SIG, "declined", { cooldownDays: 100 });
    }
    const row = await RoutineProposalDecision.findOne({ chatId: CHAT, signature: SIG });
    expect(row!.denyCount).toBe(5);
    const quietMs = row!.quietUntil.getTime() - Date.now();
    expect(quietMs).toBeLessThan(365 * DAY_MS + 60_000);
    expect(quietMs).toBeGreaterThan(365 * DAY_MS - 60_000);
  });

  it("upserts on (chatId, signature) — one row per pair", async () => {
    await recordProposalDecision(CHAT, SIG, "declined");
    await recordProposalDecision(CHAT, SIG, "declined");
    const count = await RoutineProposalDecision.countDocuments({ chatId: CHAT, signature: SIG });
    expect(count).toBe(1);
  });

  it("keeps separate rows for different signatures and chats", async () => {
    await recordProposalDecision(CHAT, SIG, "declined");
    await recordProposalDecision(CHAT, "other-sig#0000", "declined");
    await recordProposalDecision("chat-2", SIG, "declined");
    expect(await RoutineProposalDecision.countDocuments({})).toBe(3);
  });

  it("an accept does not bump denyCount", async () => {
    await recordProposalDecision(CHAT, SIG, "declined");
    await recordProposalDecision(CHAT, SIG, "accepted");
    const row = await RoutineProposalDecision.findOne({ chatId: CHAT, signature: SIG });
    expect(row!.verdict).toBe("accepted");
    expect(row!.denyCount).toBe(1);
  });
});

describe("isRecentlyDeclined", () => {
  it("returns false when no record exists", async () => {
    expect(await isRecentlyDeclined(CHAT, SIG)).toBe(false);
  });

  it("returns true within the quiet window after a decline", async () => {
    await recordProposalDecision(CHAT, SIG, "declined", { cooldownDays: 14 });
    expect(await isRecentlyDeclined(CHAT, SIG)).toBe(true);
  });

  it("returns false once the quiet window has elapsed", async () => {
    await recordProposalDecision(CHAT, SIG, "declined", { cooldownDays: 14 });
    // Force quietUntil into the past without touching the row's existence.
    await RoutineProposalDecision.updateOne(
      { chatId: CHAT, signature: SIG },
      { quietUntil: new Date(Date.now() - 1000) },
    );
    expect(await isRecentlyDeclined(CHAT, SIG)).toBe(false);
  });

  it("returns true for an accepted record (routine already exists — don't re-propose)", async () => {
    await recordProposalDecision(CHAT, SIG, "accepted");
    expect(await isRecentlyDeclined(CHAT, SIG)).toBe(true);
  });
});
