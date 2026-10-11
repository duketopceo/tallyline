// 16px stroke icons for the sidebar rail; decorative (labels sit beside them)
const P: Record<string, string> = {
  "my-issues": "M8 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 13.5c.6-2 2.3-3 5-3s4.4 1 5 3",
  board: "M2.5 3h3.2v10H2.5zM6.4 3h3.2v6.5H6.4zM10.3 3h3.2v8.2h-3.2z",
  triage: "M2.5 8.5h3l1 1.7h3l1-1.7h3M3.6 3.5h8.8l1.1 5v3.5a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V8.5z",
  review: "M3 8.3l3.2 3.2L13 4.7",
  cycle: "M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.6h-2.6",
  issues: "M3 4.5h10M3 8h10M3 11.5h6",
  insights: "M3 13V8.5M7 13V3.5M11 13V6.5M14 13H2",
  roadmap: "M2.5 4.5h6M5.5 8h8M3.5 11.5h5.5",
  activity: "M2 8h2.6l1.8-4.5 3 9L11 8h3",
  settings: "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 1.8v1.6M8 12.6v1.6M2.6 5l1.4.8M12 10.2l1.4.8M2.6 11l1.4-.8M12 5.8l1.4-.8",
  search: "M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM10.5 10.5L14 14",
  plus: "M8 3v10M3 8h10",
  menu: "M2.5 4.5h11M2.5 8h11M2.5 11.5h11",
  collapse: "M9.5 3.5L5 8l4.5 4.5",
  view: "M2.5 5.5h11M4.5 8.5h7M6.5 11.5h3",
};

export function NavIcon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d={P[name] ?? P.issues} />
    </svg>
  );
}
