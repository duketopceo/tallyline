"use client";

// The single import surface for product icons (Silver Lining section 17).
// Components import product names from here — never @phosphor-icons/react.
// Weight stays `regular` at 16px; `bold` for active/emphasis only.
export {
  Tray as IconInbox,
  Kanban as IconBoard,
  Funnel as IconTriage,
  CheckCircle as IconReview,
  ArrowsClockwise as IconCycle,
  Rows as IconIssues,
  ChartBar as IconInsights,
  MapTrifold as IconRoadmap,
  Pulse as IconActivity,
  Gear as IconSettings,
  MagnifyingGlass as IconSearch,
  Plus as IconPlus,
  List as IconMenu,
  CaretLeft as IconCollapse,
  CaretRight as IconChevron,
  FunnelSimple as IconView,
  User as IconMyIssues,
  X as IconX,
  Check as IconCheck,
  Circle as IconCircle,
  CircleDashed as IconBacklog,
  CircleHalf as IconInProgress,
  CircleHalfTilt as IconInReview,
  XCircle as IconCanceled,
  MinusCircle as IconDuplicate,
  CheckCircle as IconDone,
  Warning as IconUrgent,
  CellSignalNone as IconNoPriority,
  CellSignalLow as IconLow,
  CellSignalMedium as IconMedium,
  CellSignalHigh as IconHigh,
  UserCircleDashed as IconUnassigned,
  SidebarSimple as IconPeek,
  Sun as IconSun,
  Moon as IconMoon,
  Monitor as IconMonitor,
} from "@phosphor-icons/react";

import {
  ArrowsClockwise,
  ChartBar,
  Circle,
  CircleDashed,
  CircleHalf,
  CircleHalfTilt,
  Funnel,
  FunnelSimple,
  Gear,
  Kanban,
  List,
  MagnifyingGlass,
  MapTrifold,
  MinusCircle,
  Plus,
  Pulse,
  Rows,
  Tray,
  User,
  XCircle,
  CheckCircle,
  CaretLeft,
} from "@phosphor-icons/react";
import type { IssueState } from "@tallyline/types";

// Sidebar-rail names → glyphs. Unknown names fall back to the issues icon.
export const NAV_ICONS = {
  "my-issues": User,
  inbox: Tray,
  board: Kanban,
  triage: Funnel,
  review: CheckCircle,
  cycle: ArrowsClockwise,
  issues: Rows,
  insights: ChartBar,
  roadmap: MapTrifold,
  activity: Pulse,
  settings: Gear,
  search: MagnifyingGlass,
  plus: Plus,
  menu: List,
  collapse: CaretLeft,
  view: FunnelSimple,
} as const;

// Issue-state vocabulary: ring family, filled progressively.
import {
  CellSignalHigh,
  CellSignalLow,
  CellSignalMedium,
  CellSignalNone,
  Warning,
} from "@phosphor-icons/react";
import type { Priority } from "@tallyline/types";

export const PRIORITY_ICONS: Record<Priority, typeof Warning> = {
  none: CellSignalNone,
  low: CellSignalLow,
  medium: CellSignalMedium,
  high: CellSignalHigh,
  urgent: Warning,
};

export const STATE_ICONS: Record<IssueState, typeof Circle> = {
  triage: Funnel,
  backlog: CircleDashed,
  todo: Circle,
  in_progress: CircleHalf,
  in_review: CircleHalfTilt,
  done: CheckCircle,
  canceled: XCircle,
  duplicate: MinusCircle,
};
