"use client";

import dynamic from "next/dynamic";
import { LoadingState } from "./primitives";
import type { RoadmapSummary } from "@/lib/roadmap-pulse";
import type {
  RoadmapCycle,
  RoadmapMilestone,
  RoadmapProject,
  RoadmapTeam,
} from "./roadmap-client";

// ssr:false keeps the roadmap's client code out of the initial bundle (R10)
const RoadmapClient = dynamic(
  () => import("./roadmap-client").then((m) => m.RoadmapClient),
  {
    ssr: false,
    loading: () => <LoadingState label="loading roadmap…" />,
  },
);

const PushView = dynamic(
  () => import("./roadmap-pulse").then((m) => m.PushView),
  { ssr: false, loading: () => <LoadingState label="loading push view…" /> },
);

export function PushLoader(props: {
  summary: RoadmapSummary;
  projects: { id: string; name: string; status: string }[];
  milestones: { id: string; projectId: string; title: string; targetDate: string | null; done: boolean }[];
}) {
  return <PushView initial={props.summary} projects={props.projects} milestones={props.milestones} />;
}

export function RoadmapLoader(props: {
  projects: RoadmapProject[];
  cycles: RoadmapCycle[];
  milestones: RoadmapMilestone[];
  summary: RoadmapSummary;
  teams: RoadmapTeam[];
}) {
  return <RoadmapClient {...props} />;
}
