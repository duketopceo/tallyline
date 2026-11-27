"use client";

import { useEffect } from "react";
import { captureWebException } from "@/lib/telemetry";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureWebException(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="antialiased p-6">
        <div className="max-w-md mx-auto space-y-3">
          <h1 className="text-headline font-medium">Something went wrong</h1>
          <p className="text-sm opacity-75">
            An unexpected error occurred while rendering this page. Your data is unchanged.
          </p>
          <button
            type="button"
            onClick={reset}
            className="px-3 py-1.5 text-sm border rounded"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
