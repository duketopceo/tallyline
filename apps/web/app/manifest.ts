import { tokens } from "@tallyline/silver-lining";
import type { MetadataRoute } from "next";

const CANVAS = tokens.dark.canvas;

// Installable web app: "Add to Home Screen" on a phone opens Tallyline
// standalone, straight into the app. A manifest cannot follow the theme, so
// its colours are the dark canvas; the page's own theme-color meta tags
// (app/layout.tsx) follow light and dark.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tallyline",
    short_name: "Tallyline",
    description: "Agent-native issue tracker",
    start_url: "/my-issues",
    scope: "/",
    display: "standalone",
    background_color: CANVAS,
    theme_color: CANVAS,
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
