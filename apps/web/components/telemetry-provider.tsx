"use client";

import { useEffect } from "react";
import { initWebTelemetry } from "@/lib/telemetry";

// Mounts once in RootLayout. Zero-op when NEXT_PUBLIC_SENTRY_DSN is unset.
export function TelemetryProvider() {
  useEffect(() => {
    initWebTelemetry();
  }, []);
  return null;
}
