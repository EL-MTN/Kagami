import { getSkillList } from "@/lib/queries/skills";
import { SkillTable } from "@/components/skills/skill-table";

export default async function SkillsPage() {
  const skills = await getSkillList();

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Skills</h2>
      <SkillTable initialSkills={skills} />
    </div>
  );
}
