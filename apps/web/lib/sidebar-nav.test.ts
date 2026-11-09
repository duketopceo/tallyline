import { describe, expect, it } from "vitest";
import { GOTO } from "./goto-map";
import { allItems, buildSidebarNav, PROJECTS_IN_SIDEBAR, type NavInput } from "./sidebar-nav";

const base: NavInput = {
  role: "member",
  counts: { triage: 0, review: 0, unread: 0 },
  projects: [],
  views: [],
  pathname: "/my-issues",
  search: "",
};
const nav = (o: Partial<NavInput> = {}) => buildSidebarNav({ ...base, ...o });
const find = (o: Partial<NavInput>, id: string) => allItems(nav(o)).find((i) => i.id === id);
const currentIds = (o: Partial<NavInput>) => allItems(nav(o)).filter((i) => i.current).map((i) => i.id);

describe("buildSidebarNav", () => {
  it("groups the sidebar in the agreed order", () => {
    expect(nav().map((s) => s.id)).toEqual(["workspace", "work", "projects", "planning", "settings"]);
    expect(nav()[0]!.items.map((i) => i.label)).toEqual(["Overview", "My issues", "Inbox"]);
    expect(nav()[3]!.items.map((i) => i.label)).toEqual(["Roadmap", "Cycles"]);
  });

  it("shows Settings only to owners and admins", () => {
    expect(find({ role: "member" }, "settings")).toBeUndefined();
    expect(find({ role: "owner" }, "settings")).toBeDefined();
    expect(find({ role: "admin" }, "settings")).toBeDefined();
  });

  it("badges only the non-zero counts", () => {
    const o = { counts: { triage: 3, review: 0, unread: 12 } };
    expect(find(o, "triage")?.count).toBe(3);
    expect(find(o, "inbox")?.count).toBe(12);
    expect(find(o, "review")?.count).toBeUndefined();
  });

  it("marks exactly one item current on a project page", () => {
    const projects = [{ id: "abc", name: "Kate" }, { id: "def", name: "Cairn" }];
    expect(currentIds({ projects, pathname: "/projects/abc" })).toEqual(["project-abc"]);
  });

  it("keeps Overview current on a project outside the capped list", () => {
    const projects = Array.from({ length: PROJECTS_IN_SIDEBAR + 4 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
    expect(currentIds({ projects, pathname: "/projects/p11" })).toEqual(["overview"]);
  });

  it("marks Issues for a key and the saved view, not Issues, for a matching query", () => {
    expect(currentIds({ pathname: "/issues/TLY-1" })).toEqual(["issues"]);
    const views = [{ id: "v1", name: "Mine", filters: { state: ["todo"] } }];
    const q = allItems(nav({ views })).find((i) => i.id === "view-v1")!.href.split("?")[1]!;
    expect(currentIds({ views, pathname: "/issues", search: q })).toEqual(["view-v1"]);
    expect(currentIds({ views, pathname: "/issues", search: "" })).toEqual(["issues"]);
  });

  it("explains an empty Projects group and caps a long one with a link", () => {
    const empty = nav().find((s) => s.id === "projects")!;
    expect(empty.items).toHaveLength(0);
    expect(empty.empty).toBe("No projects yet");
    const projects = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
    const capped = nav({ projects }).find((s) => s.id === "projects")!;
    expect(capped.items).toHaveLength(PROJECTS_IN_SIDEBAR);
    expect(capped.more).toEqual({ href: "/overview", label: "View all 12" });
  });

  it("only advertises g-sequences that exist, one per item", () => {
    const hints = allItems(nav({ role: "owner" })).filter((i) => i.hint);
    for (const i of hints) {
      const key = i.hint!.replace(/^g /, "");
      expect(GOTO[key], i.label).toBe(i.href);
    }
    expect(new Set(hints.map((i) => i.hint)).size).toBe(hints.length);
  });
});
