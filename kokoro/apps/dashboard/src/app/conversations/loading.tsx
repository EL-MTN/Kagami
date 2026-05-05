export default function Loading() {
  return (
    <div className="space-y-8">
      <div>
        <div className="skeleton h-9 w-52" />
        <div className="skeleton mt-2 h-4 w-64" />
      </div>
      <div className="skeleton h-96 rounded-xl" />
    </div>
  );
}
