"use client";

import { SegmentError } from "@/components/app/segment-error";

export default function ReviewError({ reset }: { error: Error; reset: () => void }) {
  return <SegmentError label="The review queue" reset={reset} />;
}
