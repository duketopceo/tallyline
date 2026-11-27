"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/primitives";
import { captureWebException } from "@/lib/telemetry";

export default function AppError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    captureWebException(error);
  }, [error]);

  return (
    <div className="p-6">
      <ErrorState
        title="This view failed to load"
        detail="Something went wrong while rendering. Your data is unchanged."
        actionLabel="Retry"
        onAction={reset}
      />
    </div>
  );
}
