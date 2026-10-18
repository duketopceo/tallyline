"use client";

import { SegmentError } from "@/components/app/segment-error";

export default function TriageError({ reset }: { error: Error; reset: () => void }) {
  return <SegmentError label="Triage" reset={reset} />;
}
