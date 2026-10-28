"use client";

import { useEffect, useState } from "react";

// One project glyph for every surface: the project's stored logo when it has
// one (lazy-loaded at a fixed size, no referrer), else an initial tile. A
// broken image falls back to the same tile.
export function ProjectIcon({
  name,
  iconUrl,
  size = 16,
}: {
  name: string;
  iconUrl?: string | null | undefined;
  size?: 14 | 16 | 20;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [iconUrl]);
  const box = { width: size, height: size };
  if (iconUrl && !failed) {
    return (
      <img
        src={iconUrl}
        alt=""
        aria-hidden
        {...box}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="shrink-0 rounded-xs bg-surface-3 object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{ ...box, fontSize: Math.round(size * 0.6) }}
      className="inline-flex shrink-0 items-center justify-center rounded-xs bg-surface-3 font-semibold uppercase leading-none text-ink-muted"
    >
      {[...name.trim()][0] ?? "?"}
    </span>
  );
}
