import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RoutineEditor } from "@/components/routines/routine-editor";
import { RoutineLogTable } from "@/components/routines/routine-log-table";
import { getRoutineDetail, getRoutineLogList } from "@/lib/queries/routines";

export default async function RoutineDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [routine, logResult] = await Promise.all([getRoutineDetail(id), getRoutineLogList(id, 50)]);

  if (!routine) notFound();

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon-sm"
          asChild
          className="text-muted-foreground hover:text-foreground"
        >
          <Link href="/routines">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h2 className="font-display text-2xl text-foreground">{routine.name}</h2>
          <p className="text-xs text-faint">{routine.description}</p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <RoutineEditor routine={routine} />
      </div>

      <div>
        <h3 className="mb-4 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
          Execution History
        </h3>
        <RoutineLogTable
          routineId={id}
          initialLogs={logResult.logs}
          initialHasMore={logResult.hasMore}
        />
      </div>
    </div>
  );
}
