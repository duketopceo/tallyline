import { filtersFromObject, filtersToQuery } from "@/lib/filters";
import { hintFor } from "@/lib/goto-map";

// The sidebar as data: sections of items, with the active state and the `g`
// hints already decided. components/app/shell.tsx only renders it.

export interface NavItem {
  id: string;
  href: string;
  label: string;
  icon: string;
  hint?: string;
  count?: number;
  current: boolean;
}

export interface NavSection {
  id: "workspace" | "work" | "projects" | "planning" | "views" | "settings";
  label: string;
  items: NavItem[];
  /** shown when the group has no items but should still explain itself */
  empty?: string;
  /** a "view all" link under a capped list */
  more?: { href: string; label: string };
}

export interface NavInput {
  role: string | undefined;
  counts: { triage: number; review: number; unread: number };
  projects: { id: string; name: string }[];
  views: { id: string; name: string; filters: Record<string, unknown> }[];
  pathname: string;
  /** the current query string without the leading "?" */
  search: string;
}

export const PROJECTS_IN_SIDEBAR = 8;

export function buildSidebarNav(input: NavInput): NavSection[] {
  const { pathname } = input;
  const views = input.views.map((v) => ({ ...v, q: filtersToQuery(filtersFromObject(v.filters)) }));
  const activeView = pathname === "/issues" ? views.find((v) => v.q === input.search) : undefined;
  const inArea = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  const item = (id: string, href: string, label: string, icon: string, current: boolean, count = 0): NavItem => {
    const hint = hintFor(href);
    return { id, href, label, icon, current, ...(hint ? { hint } : {}), ...(count > 0 ? { count } : {}) };
  };

  const isAdmin = input.role === "owner" || input.role === "admin";
  const projectRows: NavItem[] = input.projects.slice(0, PROJECTS_IN_SIDEBAR).map((p) => ({
    id: `project-${p.id}`,
    href: `/projects/${p.id}`,
    label: p.name,
    icon: "project",
    current: inArea(`/projects/${p.id}`),
  }));
  // on a project page the project row is the one current item; Overview keeps
  // the highlight only when that project is not in the capped list
  const onListedProject = projectRows.some((r) => r.current);
  const onOverviewArea = inArea("/overview") || (pathname.startsWith("/projects/") && !onListedProject);

  const sections: NavSection[] = [
    {
      id: "workspace",
      label: "Workspace",
      items: [
        item("overview", "/overview", "Overview", "overview", onOverviewArea),
        item("my-issues", "/my-issues", "My issues", "my-issues", inArea("/my-issues")),
        item("inbox", "/notifications", "Inbox", "inbox", inArea("/notifications"), input.counts.unread),
      ],
    },
    {
      id: "work",
      label: "Work",
      items: [
        item("triage", "/triage", "Triage", "triage", inArea("/triage"), input.counts.triage),
        item("review", "/review", "Review", "review", inArea("/review"), input.counts.review),
        item("board", "/board", "Board", "board", inArea("/board")),
        item("issues", "/issues", "Issues", "issues", (pathname === "/issues" && !activeView) || pathname.startsWith("/issues/")),
        item("support", "/support", "Support", "inbox", inArea("/support")),
      ],
    },
    {
      id: "projects",
      label: "Projects",
      items: projectRows,
      ...(input.projects.length === 0 ? { empty: "No projects yet" } : {}),
      ...(input.projects.length > PROJECTS_IN_SIDEBAR
        ? { more: { href: "/overview", label: `View all ${input.projects.length}` } }
        : {}),
    },
    {
      id: "planning",
      label: "Planning",
      items: [
        item("roadmap", "/roadmap", "Roadmap", "roadmap", inArea("/roadmap")),
        item("cycle", "/cycle", "Cycles", "cycle", inArea("/cycle")),
      ],
    },
  ];

  if (views.length > 0) {
    sections.push({
      id: "views",
      label: "Views",
      items: views.map((v) => ({
        id: `view-${v.id}`,
        href: `/issues?${v.q}`,
        label: v.name,
        icon: "view",
        current: activeView?.id === v.id,
      })),
    });
  }

  sections.push({
    id: "settings",
    label: "Settings",
    items: [
      item("activity", "/activity", "Activity", "activity", inArea("/activity")),
      item("insights", "/insights", "Insights", "insights", inArea("/insights")),
      ...(isAdmin ? [item("settings", "/settings", "Settings", "settings", inArea("/settings"))] : []),
    ],
  });

  return sections;
}

/** The flat list the mobile drawer and tests walk. */
export function allItems(sections: NavSection[]): NavItem[] {
  return sections.flatMap((s) => s.items);
}
