import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@tallyline/types"],
  // no `x-powered-by: Next.js` fingerprint
  poweredByHeader: false,
  // the dev-only "N" badge sits bottom-left, over the sidebar footer controls
  // (theme toggle, sign out), and intercepts pointer events in e2e runs
  devIndicators: false,
};

export default nextConfig;
