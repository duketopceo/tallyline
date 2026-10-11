import { Skeleton } from "./ui";

// Skeletons match final geometry (36px rows, 48px header) so nothing shifts
// when data lands, and nothing animates at rest.
const W = [62, 48, 71, 40, 56, 66, 44, 58, 52, 69];

export function HeaderSkeleton({ title }: { title: string }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-lining-faint px-4">
      <h1 className="text-[15px] font-semibold">{title}</h1>
      <Skeleton className="h-3 w-8" />
    </header>
  );
}

export function ListSkeleton({ title, rows = 14 }: { title: string; rows?: number }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="status" aria-busy="true" aria-label={`Loading ${title}`}>
      <HeaderSkeleton title={title} />
      <div className="min-h-0 flex-1 overflow-hidden">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex h-9 items-center gap-3 border-b border-lining-faint px-4">
            <Skeleton className="h-3.5 w-3.5 rounded-full" />
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3" />
            <span className="h-3 rounded-xs bg-surface-3" style={{ width: `${W[i % W.length]}%`, maxWidth: 520 }} />
            <Skeleton className="ml-auto h-5 w-5 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function BoardSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="status" aria-busy="true" aria-label="Loading Board">
      <HeaderSkeleton title="Board" />
      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden p-4">
        {[5, 6, 4, 5].map((n, c) => (
          <div key={c} className="w-[300px] shrink-0 rounded-md border border-lining bg-surface-1">
            <div className="h-10 border-b border-lining-faint px-3 py-3"><Skeleton className="h-3 w-24" /></div>
            <div className="space-y-2 p-2">
              {Array.from({ length: n }, (_, i) => <Skeleton key={i} className="h-[72px] w-full" />)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="status" aria-busy="true" aria-label="Loading issue">
      <header className="flex h-12 items-center gap-3 border-b border-lining-faint px-4"><Skeleton className="h-3 w-16" /></header>
      <div className="mx-auto w-full max-w-5xl space-y-4 px-6 py-8">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}

export function PanelSkeleton({ title }: { title: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="status" aria-busy="true" aria-label={`Loading ${title}`}>
      <HeaderSkeleton title={title} />
      <div className="space-y-3 p-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  );
}
