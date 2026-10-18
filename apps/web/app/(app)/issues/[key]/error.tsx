"use client";

import { SegmentError } from "@/components/app/segment-error";

export default function IssueError({ reset }: { error: Error; reset: () => void }) {
  return <SegmentError label="This issue" reset={reset} />;
}
