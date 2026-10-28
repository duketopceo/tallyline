import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/api";
import { LandingPage } from "@/components/landing/landing";

export default async function Home() {
  const jar = await cookies();
  return <LandingPage signedIn={Boolean(jar.get(SESSION_COOKIE))} />;
}
