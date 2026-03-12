/**
 * One-time migration: workflows → skills
 *
 * Reads all workflow documents and maps them to the skill schema.
 * Also migrates workflow logs to skill logs.
 * Does NOT delete old collections — manual cleanup after verification.
 *
 * Usage: npx tsx scripts/migrate-workflows-to-skills.ts
 */

import { config, validateConfig } from "@mashiro/shared";

// Validate config before connecting
validateConfig();

import { connectDB, disconnectDB, Workflow, WorkflowLog, Skill, SkillLog } from "@mashiro/db";

async function migrate() {
  console.log("Connecting to MongoDB...");
  await connectDB();

  // Migrate workflows → skills
  const workflows = await Workflow.find({});
  console.log(`Found ${workflows.length} workflows to migrate`);

  let skillsMigrated = 0;
  let logsMigrated = 0;

  for (const workflow of workflows) {
    // Check if skill with same name already exists for this chat
    const existing = await Skill.findOne({ chatId: workflow.chatId, name: workflow.name });
    if (existing) {
      console.log(`  Skipping "${workflow.name}" (chatId: ${workflow.chatId}) — skill already exists`);
      continue;
    }

    const skill = await Skill.create({
      chatId: workflow.chatId,
      name: workflow.name,
      description: `Scheduled task: ${workflow.name}`,
      prompt: workflow.prompt,
      parameters: [],
      cronSchedule: workflow.cronSchedule,
      reportMode: workflow.reportMode,
      nextRunAt: workflow.nextRunAt,
      enabled: workflow.enabled,
      version: 1,
    });

    console.log(`  Migrated workflow "${workflow.name}" → skill ${skill._id}`);
    skillsMigrated++;

    // Migrate logs for this workflow
    const logs = await WorkflowLog.find({ workflowId: workflow._id });
    if (logs.length > 0) {
      const skillLogs = logs.map((log) => ({
        skillId: skill._id,
        trigger: "cron" as const,
        status: log.status,
        summary: log.summary,
        startedAt: log.startedAt,
        completedAt: log.completedAt,
      }));

      await SkillLog.insertMany(skillLogs);
      logsMigrated += logs.length;
      console.log(`    Migrated ${logs.length} logs`);
    }
  }

  console.log(`\nMigration complete:`);
  console.log(`  Skills migrated: ${skillsMigrated}`);
  console.log(`  Logs migrated: ${logsMigrated}`);
  console.log(`\nOld collections (workflows, workflowlogs) were NOT deleted.`);
  console.log(`Verify the migration and remove them manually if everything looks good.`);

  await disconnectDB();
}

migrate().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
