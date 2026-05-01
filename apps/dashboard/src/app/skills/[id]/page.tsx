import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SkillEditor } from "@/components/skills/skill-editor";
import { SkillLogTable } from "@/components/skills/skill-log-table";
import { getSkillDetail, getSkillLogList } from "@/lib/queries/skills";

export default async function SkillDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [skill, logResult] = await Promise.all([getSkillDetail(id), getSkillLogList(id, 50)]);

  if (!skill) notFound();

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon-sm"
          asChild
          className="text-muted-foreground hover:text-foreground"
        >
          <Link href="/skills">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h2 className="font-display text-2xl text-foreground">{skill.name}</h2>
          <p className="text-xs text-faint">{skill.description}</p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <SkillEditor skill={skill} />
      </div>

      <div>
        <h3 className="mb-4 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
          Execution History
        </h3>
        <SkillLogTable
          skillId={id}
          initialLogs={logResult.logs}
          initialHasMore={logResult.hasMore}
        />
      </div>
    </div>
  );
}
