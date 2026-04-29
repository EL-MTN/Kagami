export default function Loading() {
  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <div className="skeleton h-8 w-8 rounded-lg" />
        <div>
          <div className="skeleton h-7 w-44" />
          <div className="skeleton mt-1 h-3 w-32" />
        </div>
      </div>
      <div className="skeleton h-[520px] rounded-xl" />
      <div className="skeleton h-4 w-36" />
      <div className="skeleton h-56 rounded-xl" />
    </div>
  );
}
