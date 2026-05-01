import { PageHeader } from "@/components/shell";
import { getRoutineList } from "@/lib/queries/routines";
import { RoutineTable } from "@/components/routines/routine-table";

export default async function RoutinesPage() {
  const routines = await getRoutineList();

  return (
    <div className="space-y-8">
      <PageHeader title="Routines" description="Automated tasks and scheduled operations" />
      <RoutineTable initialRoutines={routines} />
    </div>
  );
}
