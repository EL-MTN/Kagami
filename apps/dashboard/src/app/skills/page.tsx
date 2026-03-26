import { getSkillList } from "@/lib/queries/skills";
import { SkillTable } from "@/components/skills/skill-table";

export default async function SkillsPage() {
  const skills = await getSkillList();

  return (
    <div className="space-y-8">
      <div>
        <h2 className="font-display text-3xl text-foreground">Skills</h2>
        <p className="mt-1 text-sm text-muted-foreground/70">
          Automated tasks and scheduled operations
        </p>
      </div>
      <SkillTable initialSkills={skills} />
    </div>
  );
}
