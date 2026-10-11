import type { Metadata } from "next";
import {
  APPEARANCE_COOKIE,
  generateCustom,
  parseAppearance,
  themeToStyle,
} from "@tallyline/silver-lining";
import { cookies } from "next/headers";
import type { CSSProperties, ReactNode } from "react";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";

// CSP nonces are per-request, so every page must render dynamically
// (see lib/security-headers.ts); static HTML cannot carry a nonce.
export const dynamic = "force-dynamic";

const description = "Agent-native issue tracker";

// Icons, apple-icon, opengraph-image and twitter-image come from the file
// conventions in this directory (regenerate with tools/brand/export.mjs).
export const metadata: Metadata = {
  metadataBase: new URL(process.env.WEB_URL ?? "http://localhost:3100"),
  title: "Tallyline",
  description,
  openGraph: { title: "Tallyline", description, siteName: "Tallyline", type: "website" },
  twitter: { card: "summary_large_image", title: "Tallyline", description },
};

// Per-device appearance (Settings > Appearance) lives in a cookie so the first
// paint already has the right theme: no flash, no reload. "system" sets no
// data-theme and lets prefers-color-scheme in silver-lining.css decide.
export default async function RootLayout({ children }: { children: ReactNode }) {
  const appearance = parseAppearance((await cookies()).get(APPEARANCE_COOKIE)?.value);
  const themeProps =
    appearance.theme === "system"
      ? {}
      : appearance.theme === "custom"
        ? (() => {
            const { mode, tokens } = generateCustom(appearance.custom);
            return {
              "data-theme": "custom",
              style: themeToStyle(tokens, mode) as CSSProperties,
            };
          })()
        : { "data-theme": appearance.theme };
  return (
    <html lang="en" {...themeProps}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
