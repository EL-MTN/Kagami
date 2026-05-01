import { PageHeader } from "@/components/shell";
import { getWatcherList } from "@/lib/queries/watchers";
import { WatcherTable } from "@/components/watchers/watcher-table";

export default async function WatchersPage() {
  const watchers = await getWatcherList();

  return (
    <div className="space-y-8">
      <PageHeader
        title="Watchers"
        description="Scheduled detection jobs — observe, compare, notify on change"
      />
      <WatcherTable initialWatchers={watchers} />
    </div>
  );
}
