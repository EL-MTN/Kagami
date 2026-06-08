import type { SkillPackageBundle } from "./skill-schema";

export interface SkillPackageSourceItem {
  chatId: string;
  name: string;
  description: string;
  body: string;
  triggers: string[];
  tags: string[];
  enabled: boolean;
}

export function createSkillPackageBundle(
  skills: readonly SkillPackageSourceItem[],
  exportedAt = new Date().toISOString(),
): SkillPackageBundle {
  return {
    version: 1,
    exportedAt,
    count: skills.length,
    skills: skills.map((skill) => ({
      chatId: skill.chatId,
      name: skill.name,
      description: skill.description,
      body: skill.body,
      triggers: skill.triggers,
      tags: skill.tags,
      enabled: skill.enabled,
    })),
  };
}

export function resolveSkillPackageImportChatId({
  requestedChatId,
  itemChatId,
  fallbackChatId,
}: {
  requestedChatId: string | null;
  itemChatId: string | undefined;
  fallbackChatId: string | null;
}): string | null {
  return requestedChatId ?? itemChatId ?? fallbackChatId;
}
