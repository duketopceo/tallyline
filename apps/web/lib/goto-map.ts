// `g` then a letter jumps to a page. One map, read by the key handler
// (components/global-nav.tsx) and by the sidebar model (lib/sidebar-nav.ts), so a
// sidebar hint can never advertise a binding that does not exist.
export const GOTO: Record<string, string> = {
  i: "/my-issues",
  n: "/notifications",
  t: "/triage",
  r: "/review",
  b: "/board",
  c: "/cycle",
  a: "/issues",
  u: "/support",
  s: "/insights",
  e: "/activity",
  p: "/roadmap",
  o: "/overview",
  ",": "/settings",
};

/** The `g <key>` hint text for a route, or undefined when no sequence goes there. */
export function hintFor(href: string): string | undefined {
  const key = Object.keys(GOTO).find((k) => GOTO[k] === href);
  return key ? `g ${key}` : undefined;
}
