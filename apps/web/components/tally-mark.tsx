import { useId } from "react";

// The Tallyline mark as inline SVG so it follows the active theme tokens
// (ink strokes, accent strike). `quiet` is the empty-state linework variant.
// Geometry matches assets/brand/mark-small.svg (16px optimized variant).
export function TallyMark({
  size = 16,
  fluid = false,
  quiet = false,
  label,
}: {
  size?: number;
  /** fill the parent box (keeps the 1:1 aspect) instead of a fixed pixel size */
  fluid?: boolean;
  quiet?: boolean;
  label?: string;
}) {
  const id = useId();
  const stroke = quiet ? "var(--color-lining-strong)" : "var(--color-ink)";
  const strike = quiet ? "var(--color-lining-bright)" : "var(--color-accent)";
  return (
    <svg
      width={fluid ? "100%" : size}
      height={fluid ? "100%" : size}
      viewBox="0 0 16 16"
      fill="none"
      className="shrink-0"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
          <rect width="16" height="16" fill="white" />
          <path d="M1.2 12.8L14.8 3.4" stroke="black" strokeWidth="5" strokeLinecap="round" />
        </mask>
      </defs>
      <g mask={`url(#${id})`} stroke={stroke} strokeWidth="2">
        <path d="M3 2V14" />
        <path d="M6 2V14" />
        <path d="M9 2V14" />
        <path d="M12 2V14" />
      </g>
      <path d="M1.2 12.8L14.8 3.4" stroke={strike} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
