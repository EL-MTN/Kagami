export default function Loading() {
  return (
    <div className="space-y-8">
      <div>
        <div className="skeleton h-9 w-40" />
        <div className="skeleton mt-2 h-4 w-56" />
      </div>
      <div className="skeleton h-9 w-96 rounded-lg" />
      <div className="space-y-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton h-28 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
