"use client";

import dynamic from "next/dynamic";
import { LoadingState } from "./primitives";
import type { UsageDay } from "./usage-charts";

// ssr:false keeps recharts out of the initial bundle, like insights (R10)
const UsageCharts = dynamic(() => import("./usage-charts").then((m) => m.UsageCharts), {
  ssr: false,
  loading: () => <LoadingState label="loading charts…" />,
});

export function UsageLoader({ daily }: { daily: UsageDay[] }) {
  return <UsageCharts daily={daily} />;
}
