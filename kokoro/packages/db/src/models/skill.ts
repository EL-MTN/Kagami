import mongoose, { Schema, Types, type Document } from "mongoose";

export type SkillSource = "manual" | "distilled" | "imported";
export type SkillSourceRefKind = "routine" | "conversation";

export interface ISkillSourceRef {
  kind: SkillSourceRefKind;
  id: string;
}

export interface ISkill extends Document {
  id: string;
  chatId: string;
  name: string;
  description: string;
  body: string;
  triggers: string[];
  tags: string[];
  enabled: boolean;
  source: SkillSource;
  sourceRef: ISkillSourceRef | null;
  linkedRoutineIds: Types.ObjectId[];
  version: number;
  lastUsedAt: Date | null;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const skillSourceRefSchema = new Schema<ISkillSourceRef>(
  {
    kind: { type: String, enum: ["routine", "conversation"], required: true },
    id: { type: String, required: true },
  },
  { _id: false },
);

const skillSchema = new Schema<ISkill>(
  {
    chatId: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, required: true },
    body: { type: String, required: true },
    triggers: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    enabled: { type: Boolean, default: true },
    source: { type: String, enum: ["manual", "distilled", "imported"], default: "manual" },
    sourceRef: { type: skillSourceRefSchema, default: null },
    linkedRoutineIds: { type: [Schema.Types.ObjectId], ref: "Routine", default: [] },
    version: { type: Number, default: 1 },
    lastUsedAt: { type: Date, default: null },
    usageCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

skillSchema.index({ chatId: 1, name: 1 }, { unique: true });
skillSchema.index({ chatId: 1, enabled: 1 });
skillSchema.index({ chatId: 1, tags: 1 });
skillSchema.index({
  name: "text",
  description: "text",
  body: "text",
  triggers: "text",
  tags: "text",
});

export const Skill =
  (mongoose.models.Skill as mongoose.Model<ISkill>) ?? mongoose.model<ISkill>("Skill", skillSchema);

export interface SkillInput {
  name: string;
  description: string;
  body: string;
  triggers?: string[];
  tags?: string[];
  enabled?: boolean;
  source?: SkillSource;
  sourceRef?: ISkillSourceRef | null;
  linkedRoutineIds?: string[];
}

export async function createSkill(chatId: string, input: SkillInput): Promise<ISkill> {
  return Skill.create({
    chatId,
    ...input,
    linkedRoutineIds: (input.linkedRoutineIds ?? []).map((id) => new Types.ObjectId(id)),
  });
}

export async function listSkillsForChat(chatId: string): Promise<ISkill[]> {
  return Skill.find({ chatId }).sort({ createdAt: -1 });
}

export async function listEnabledSkillsForChat(chatId: string): Promise<ISkill[]> {
  return Skill.find({ chatId, enabled: true }).sort({ createdAt: -1 });
}

export async function getSkillById(skillId: string, chatId?: string): Promise<ISkill | null> {
  const filter: Record<string, unknown> = { _id: skillId };
  if (chatId) filter.chatId = chatId;
  return Skill.findOne(filter);
}

export async function getSkillByName(chatId: string, name: string): Promise<ISkill | null> {
  return Skill.findOne({ chatId, name });
}

export async function resolveSkillRef(chatId: string, identifier: string): Promise<ISkill | null> {
  if (Types.ObjectId.isValid(identifier)) {
    const byId = await getSkillById(identifier, chatId);
    if (byId) return byId;
  }
  return getSkillByName(chatId, identifier);
}

export async function updateSkill(
  skillId: string,
  patch: Partial<
    Pick<
      ISkill,
      | "name"
      | "description"
      | "body"
      | "triggers"
      | "tags"
      | "enabled"
      | "source"
      | "sourceRef"
      | "version"
    >
  > & { linkedRoutineIds?: string[] },
  chatId?: string,
): Promise<ISkill | null> {
  const filter: Record<string, unknown> = { _id: skillId };
  if (chatId) filter.chatId = chatId;
  const update: Record<string, unknown> = { ...patch };
  if (patch.linkedRoutineIds) {
    update.linkedRoutineIds = patch.linkedRoutineIds.map((id) => new Types.ObjectId(id));
  }
  return Skill.findOneAndUpdate(filter, update, { returnDocument: "after" });
}

export async function deleteSkill(skillId: string, chatId?: string): Promise<boolean> {
  const filter: Record<string, unknown> = { _id: skillId };
  if (chatId) filter.chatId = chatId;
  const result = await Skill.findOneAndDelete(filter);
  return result !== null;
}

export async function recordSkillUsed(skillId: string, chatId?: string): Promise<void> {
  const filter: Record<string, unknown> = { _id: skillId };
  if (chatId) filter.chatId = chatId;
  await Skill.updateOne(filter, {
    $inc: { usageCount: 1 },
    $set: { lastUsedAt: new Date() },
  });
}
