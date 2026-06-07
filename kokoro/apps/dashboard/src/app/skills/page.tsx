import { PageHeader } from "@/components/shell";
import { SkillTable } from "@/components/skills/skill-table";
import { getSkillList } from "@/lib/queries/skills";

export default async function SkillsPage() {
  const skills = await getSkillList();

  return (
    <div className="space-y-8">
      <PageHeader title="Skills" description="Procedural context and reusable guidance" />
      <SkillTable initialSkills={skills} />
    </div>
  );
}
