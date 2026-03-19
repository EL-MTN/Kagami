import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SkillEditor } from "@/components/skills/skill-editor";
import { SkillLogTable } from "@/components/skills/skill-log-table";
import { getSkillDetail, getSkillLogList } from "@/lib/queries/skills";

export default async function SkillDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [skill, logResult] = await Promise.all([getSkillDetail(id), getSkillLogList(id, 50)]);

  if (!skill) notFound();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link href="/skills">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h2 className="text-2xl font-bold">{skill.name}</h2>
      </div>

      <Card>
        <CardContent className="pt-6">
          <SkillEditor skill={skill} />
        </CardContent>
      </Card>

      <h3 className="text-lg font-semibold">Execution History</h3>

      <SkillLogTable skillId={id} initialLogs={logResult.logs} initialHasMore={logResult.hasMore} />
    </div>
  );
}
