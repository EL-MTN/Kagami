export default function Loading() {
  return (
    <div className="space-y-8">
      <div>
        <div className="skeleton h-9 w-32" />
        <div className="skeleton mt-2 h-4 w-72" />
      </div>
      <div className="skeleton h-80 rounded-xl" />
    </div>
  );
}
