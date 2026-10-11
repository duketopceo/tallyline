"use client";

import dynamic from "next/dynamic";
import type { ListIssue } from "./issue-list-client";
import { BoardColumnsSkeleton } from "./app/skeletons";

// ssr:false keeps dnd-kit out of the initial bundle (R10); the columns
// mount client-side under a skeleton that matches the final geometry
const BoardClient = dynamic(() => import("./board-client").then((m) => m.BoardClient), {
  ssr: false,
  loading: () => <BoardColumnsSkeleton />,
});

export function BoardLoader({ issues }: { issues: ListIssue[] }) {
  return <BoardClient issues={issues} />;
}
