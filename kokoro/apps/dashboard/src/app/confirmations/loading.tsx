export default function Loading() {
  return (
    <div className="space-y-8">
      <div>
        <div className="skeleton h-9 w-48" />
        <div className="skeleton mt-2 h-4 w-72" />
      </div>
      <div className="space-y-3">
        <div className="skeleton h-3 w-20" />
        <div className="skeleton h-24 rounded-xl" />
        <div className="skeleton h-24 rounded-xl" />
      </div>
    </div>
  );
}
