import { describe, expect, it } from "vitest";
import {
  createSkillPackageBundle,
  resolveSkillPackageImportChatId,
} from "../src/lib/skill-package";
import { skillPackageBundleSchema } from "../src/lib/skill-schema";

describe("skill packages", () => {
  it("accepts empty export bundles for round-trip imports", () => {
    const parsed = skillPackageBundleSchema.safeParse({
      version: 1,
      exportedAt: "2026-06-08T00:00:00.000Z",
      count: 0,
      skills: [],
    });

    expect(parsed.success).toBe(true);
  });

  it("preserves per-chat scope when exporting duplicate skill names", () => {
    const bundle = createSkillPackageBundle(
      [
        {
          chatId: "chat-a",
          name: "meeting-followup-style",
          description: "Follow-up style for chat A.",
          body: "Use the chat A voice.",
          triggers: ["meeting"],
          tags: ["writing"],
          enabled: true,
        },
        {
          chatId: "chat-b",
          name: "meeting-followup-style",
          description: "Follow-up style for chat B.",
          body: "Use the chat B voice.",
          triggers: ["meeting"],
          tags: ["writing"],
          enabled: false,
        },
      ],
      "2026-06-08T00:00:00.000Z",
    );

    expect(bundle.count).toBe(2);
    expect(bundle.skills.map((skill) => skill.chatId)).toEqual(["chat-a", "chat-b"]);
    expect(skillPackageBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it("imports into item chat scopes unless a requested chat overrides them", () => {
    expect(
      resolveSkillPackageImportChatId({
        requestedChatId: null,
        itemChatId: "chat-from-package",
        fallbackChatId: "chat-fallback",
      }),
    ).toBe("chat-from-package");

    expect(
      resolveSkillPackageImportChatId({
        requestedChatId: "chat-requested",
        itemChatId: "chat-from-package",
        fallbackChatId: "chat-fallback",
      }),
    ).toBe("chat-requested");
  });
});
