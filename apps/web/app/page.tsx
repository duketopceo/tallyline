import type { Metadata } from "next";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/api";
import { META } from "@/components/landing/copy";
import { LandingPage } from "@/components/landing/landing";

// Server-rendered, so crawlers get the heading, the copy and the title without
// running any script. The 3D hero is a progressive layer (components/landing/tally-hero.tsx).
export const metadata: Metadata = {
  title: { absolute: META.title },
  description: META.description,
  openGraph: { title: META.title, description: META.description, siteName: "Tallyline", type: "website" },
  twitter: { card: "summary_large_image", title: META.title, description: META.description },
};

export default async function Home() {
  const jar = await cookies();
  return <LandingPage signedIn={Boolean(jar.get(SESSION_COOKIE))} />;
}
