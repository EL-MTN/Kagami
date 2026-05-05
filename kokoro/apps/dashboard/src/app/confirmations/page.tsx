import { ConfirmationCard } from "@/components/confirmation-card";
import { EmptyState, LinkFilterPills, PageHeader } from "@/components/shell";
import {
  getPendingConfirmationList,
  getRecentResolvedConfirmations,
} from "@/lib/queries/confirmations";

export const dynamic = "force-dynamic";

const VIEWS = ["pending", "history"] as const;
type View = (typeof VIEWS)[number];

export default async function ConfirmationsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view: viewParam } = await searchParams;
  const view: View = VIEWS.includes(viewParam as View) ? (viewParam as View) : "pending";

  const [pending, resolved] = await Promise.all([
    getPendingConfirmationList(),
    view === "history" ? getRecentResolvedConfirmations(50) : Promise.resolve([]),
  ]);

  const items = view === "pending" ? pending : resolved;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Confirmations"
        description="Actions Mashiro is waiting on you to approve"
        meta={<span className="text-xs tabular-nums text-faint">{pending.length} pending</span>}
      />

      <LinkFilterPills<View>
        active={view}
        options={[
          {
            value: "pending",
            label: "pending",
            count: pending.length,
            href: "/confirmations",
          },
          { value: "history", label: "history", href: "/confirmations?view=history" },
        ]}
      />

      {items.length > 0 ? (
        <div className="stagger space-y-3">
          {items.map((item) => (
            <ConfirmationCard key={item.id} item={item} resolved={view === "history"} />
          ))}
        </div>
      ) : (
        <EmptyState>
          {view === "pending"
            ? "Nothing awaiting approval — Mashiro is idle."
            : "No resolved confirmations yet."}
        </EmptyState>
      )}
    </div>
  );
}
