#!/usr/bin/env python3
"""Build the per-project mark SVGs served at /brand/marks/<slug>.svg.

Each mark is a full-opacity square tile with the project's own glyph, so it
reads at 16 px in the sidebar and tab. Shapes and colours are taken from the
project's own brand files where they exist (see `source` in each entry);
projects without a brand mark get a simple monogram and a note here so the
owner can replace them.

Usage: python3 scripts/make-project-marks.py <out-dir>
"""
from __future__ import annotations

import sys
from pathlib import Path

S = 32  # the shared mark canvas; every other asset in assets/brand uses 32

# One square tile helper: rounded background, centred glyph.
TILE = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" '
    'role="img" aria-label="{name}"><title>{name}</title>'
    '<rect width="32" height="32" rx="7" fill="{bg}"/>{body}</svg>\n'
)


def tile(name: str, bg: str, body: str) -> str:
    return TILE.format(name=name, bg=bg, body=body)


# name -> (file slug, svg, where the shapes came from)
MARKS: dict[str, tuple[str, str, str]] = {}

# Tallyline: four bars crossed by the blue tally stroke. tallyline/assets/brand/mark.svg
MARKS["Tallyline"] = (
    "tallyline",
    tile(
        "Tallyline",
        "#0b1524",
        '<g stroke="#f4f7fb" stroke-width="4.2" stroke-linecap="round">'
        '<path d="M9.5 7.5V24.5"/><path d="M16 7.5V24.5"/><path d="M22.5 7.5V24.5"/></g>'
        '<path d="M6.5 22.5L25.5 9.5" stroke="#3d8ef0" stroke-width="4.2" stroke-linecap="round"/>',
    ),
    "tallyline/assets/brand/mark.svg",
)

# Kate: gold sun over the paper and rose hills on teal. kate/design/logo.svg
MARKS["Kate"] = (
    "kate",
    tile(
        "Kate",
        "#2b776f",
        '<circle cx="16" cy="14" r="6.6" fill="#e1a447"/>'
        '<path d="M2 21.2C8 18.6 13 20 17 21.4 22 23.2 27 22.4 30 20.4V30H2Z" fill="#fcf8f1"/>'
        '<path d="M2 25.6C7.5 23.2 13 25 18.5 26 24 27 27 26.6 30 25.4V30H2Z" fill="#9d4b5a"/>',
    ),
    "kate/design/logo.svg",
)

# WordInk: two ink blocks around a nib. WordInk/assets/brand/logo.svg
MARKS["WordInk"] = (
    "wordink",
    tile(
        "WordInk",
        "#0e1116",
        '<rect x="7" y="12" width="3.4" height="8.6" rx="1.7" fill="#f6f3ec"/>'
        '<rect x="21.6" y="12" width="3.4" height="8.6" rx="1.7" fill="#f6f3ec"/>'
        '<path d="M16 6.4a1.7 1.7 0 0 1 3.4 0v11.4L17.7 24.4 16 17.8z" fill="#2fbfc9"/>',
    ),
    "WordInk/assets/brand/logo.svg",
)

# Wisp: the flame-leaf path, inked white on the wisp ink. wisp/assets/brand/mark.svg
MARKS["Wisp"] = (
    "wisp",
    tile(
        "Wisp",
        "#1b2333",
        '<path transform="translate(8 8) scale(1)" fill="#dfe8ff" d="M6.5 14.5C4 14.5 2 12.5 2 10 2 7.5 4 5.5 6.5 5.5 8.25 5.5 9.25 4.6 10.5 3.25 11.5 2.2 12.6 1.6 14 1.75 12.9 2.4 12.25 3.4 11.9 4.6 11.5 6 11 7.25 11 10 11 12.5 9 14.5 6.5 14.5Z"/>',
    ),
    "wisp/assets/brand/mark.svg",
)

# Pace: the baton bar and dial with the signal dot. Pace-Server/brand/mark/pace-mark-32.svg
MARKS["Pace"] = (
    "pace",
    tile(
        "Pace",
        "#12151b",
        '<g fill="#f5f6f8"><rect x="7.6" y="4.8" width="3.4" height="22.4" rx="1"/>'
        '<path d="M7.6 13.9A9.0 9.0 0 1 1 16.6 23.5L17 19.9A5.5 5.5 0 1 0 11.1 13.9Z"/></g>'
        '<circle cx="16.6" cy="13.9" r="2.8" fill="#D33C11"/>',
    ),
    "Pace-Server/brand/mark/pace-mark-32.svg",
)

# Nimbus: a CSS cloud over an iOS-blue sky. project-nimbus has a raster app icon only.
MARKS["Project Nimbus"] = (
    "nimbus",
    tile(
        "Project Nimbus",
        "#1d4ed8",
        '<g fill="#ffffff"><circle cx="12" cy="19" r="5.2"/><circle cx="20" cy="17.6" r="4.2"/>'
        '<circle cx="16" cy="14.6" r="4.8"/><rect x="7.4" y="19" width="17.4" height="5.4" rx="2.7"/></g>',
    ),
    "monogram (project-nimbus ships an AppIcon.png only)",
)

# ReactorSim: a core dot inside the containment ring, with a coolant arc.
MARKS["ReactorSim"] = (
    "reactor-sim",
    tile(
        "ReactorSim",
        "#0f1a12",
        '<circle cx="16" cy="16" r="8" fill="none" stroke="#74e08d" stroke-width="2.4"/>'
        '<circle cx="16" cy="16" r="3" fill="#f2f7a1"/>'
        '<path d="M16 4a12 12 0 0 1 10.4 6" fill="none" stroke="#3f8f5a" stroke-width="2.4" stroke-linecap="round"/>',
    ),
    "monogram (reactor-sim ships a Blender source only)",
)

# switchboard: three contacts bridged by a live trace.
MARKS["switchboard"] = (
    "switchboard",
    tile(
        "switchboard",
        "#171a1f",
        '<g fill="none" stroke="#8fb8ff" stroke-width="2.2" stroke-linecap="round">'
        '<path d="M11 12.5v9M16 12.5v9M21 12.5v9"/><path d="M10 9.5h12"/></g>'
        '<g fill="#f0a24a"><circle cx="11" cy="21.8" r="1.6"/><circle cx="16" cy="21.8" r="1.6"/>'
        '<circle cx="21" cy="21.8" r="1.6"/></g>',
    ),
    "monogram (switchboard has no brand mark)",
)

# vein: a branching trunk, the domain graph in miniature.
MARKS["vein"] = (
    "vein",
    tile(
        "vein",
        "#1a1420",
        '<g fill="none" stroke="#e0699b" stroke-width="2.2" stroke-linecap="round">'
        '<path d="M16 26V15"/><path d="M16 15L9.5 9"/><path d="M16 15l6.5-6"/></g>'
        '<g fill="#f5c7db"><circle cx="16" cy="26" r="2"/><circle cx="9.5" cy="9" r="2"/>'
        '<circle cx="22.5" cy="9" r="2"/></g>',
    ),
    "monogram (vein has no brand mark)",
)

# viva: an open page with a highlighted line and a check.
MARKS["viva"] = (
    "viva",
    tile(
        "viva",
        "#13211d",
        '<rect x="8" y="6" width="16" height="20" rx="2.4" fill="#eaf7f1"/>'
        '<rect x="11" y="11" width="8" height="1.8" rx=".9" fill="#4fb08c"/>'
        '<rect x="11" y="15" width="10" height="1.8" rx=".9" fill="#b9d0c5"/>'
        '<path d="M11 20.2l1.9 1.9 3.6-3.9" fill="none" stroke="#1d8a5f" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
    ),
    "monogram (viva has no brand mark)",
)

# Open Computer: the open-frame bracket with the amber entry. open-computer/assets/brand/mark.svg
MARKS["Open Computer"] = (
    "open-computer",
    tile(
        "Open Computer",
        "#14181b",
        '<g fill="none" stroke-linecap="round" stroke-linejoin="round">'
        '<path d="M7 12.5V6h18v20H7v-6.5" stroke="#f2f4f6" stroke-width="2.6"/>'
        '<path d="M5.5 16H13" stroke="#e2611f" stroke-width="2.6"/>'
        '<circle cx="19" cy="16" r="3.2" fill="#e2611f" stroke="none"/></g>',
    ),
    "open-computer/assets/brand/mark.svg",
)


def main(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for name, (slug, svg, _src) in MARKS.items():
        (out / f"{slug}.svg").write_text(svg, encoding="utf-8")
        print(f"{slug}.svg  {name}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: make-project-marks.py <out-dir>")
    main(Path(sys.argv[1]))
