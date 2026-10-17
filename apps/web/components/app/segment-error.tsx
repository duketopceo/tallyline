"use client";

import { ErrorState } from "@/components/primitives";

// Segment-level boundary: a route's own failure, contained — the shell and
// siblings keep working. Root-level failures still hit (app)/error.tsx.
export function SegmentError({ label, reset }: { label: string; reset: () => void }) {
  return (
    <div className="p-6">
      <ErrorState
        title={`${label} failed to load`}
        detail="The rest of the app is fine. Retry below; if it keeps failing the API may be down."
        actionLabel="Retry"
        onAction={reset}
      />
    </div>
  );
}
