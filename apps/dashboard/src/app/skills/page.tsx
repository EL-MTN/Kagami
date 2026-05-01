import { PageHeader } from "@/components/shell";
import { getSkillList } from "@/lib/queries/skills";
import { SkillTable } from "@/components/skills/skill-table";

export default async function SkillsPage() {
  const skills = await getSkillList();

  return (
    <div className="space-y-8">
      <PageHeader title="Skills" description="Automated tasks and scheduled operations" />
      <SkillTable initialSkills={skills} />
    </div>
  );
}
