export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <div className="skeleton h-8 w-8 rounded-lg" />
        <div>
          <div className="skeleton h-7 w-44" />
          <div className="skeleton mt-1 h-3 w-32" />
        </div>
      </div>
      <div className="skeleton h-16 rounded-xl" />
      <div className="space-y-3">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className={`flex ${i % 2 === 0 ? "justify-end" : "justify-start"}`}>
            <div className="skeleton h-16 w-2/3 rounded-2xl" />
          </div>
        ))}
      </div>
    </div>
  );
}
