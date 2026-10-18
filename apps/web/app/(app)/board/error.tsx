"use client";

import { SegmentError } from "@/components/app/segment-error";

export default function BoardError({ reset }: { error: Error; reset: () => void }) {
  return <SegmentError label="The board" reset={reset} />;
}
