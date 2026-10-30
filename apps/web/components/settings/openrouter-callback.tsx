"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Notice, errorMessage, ghostBtn } from "./ui";

type Phase = { kind: "working" } | { kind: "done"; model: string } | { kind: "failed"; message: string };

export function OpenRouterCallback({ code, state }: { code: string; state: string }) {
  const [phase, setPhase] = useState<Phase>(
    code && state
      ? { kind: "working" }
      : { kind: "failed", message: "OpenRouter didn't send a sign-in code. Start Connect OpenRouter again." },
  );
  const sent = useRef(false);

  useEffect(() => {
    // React strict mode runs effects twice in dev; the code is single-use
    if (!code || !state || sent.current) return;
    sent.current = true;
    void (async () => {
      const res = await fetch("/api/settings/ai/openrouter/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, state }),
      });
      if (res.ok) {
        const body = (await res.json()) as { provider: { model: string } | null };
        setPhase({ kind: "done", model: body.provider?.model ?? "" });
        // drop the one-time code from the address bar and history
        window.history.replaceState(null, "", "/settings/ai/openrouter");
      } else {
        setPhase({ kind: "failed", message: await errorMessage(res, "could not finish connecting OpenRouter") });
      }
    })();
  }, [code, state]);

  return (
    <div className="max-w-xl p-4">
      {phase.kind === "working" && (
        <p role="status" className="text-sm text-ink-subtle">
          Finishing the connection with OpenRouter…
        </p>
      )}
      {phase.kind === "done" && (
        <Notice tone="healthy" title="OpenRouter is connected">
          AI features in this workspace now use your OpenRouter account
          {phase.model ? ` (model ${phase.model})` : ""}. The key is stored sealed and is never shown.
        </Notice>
      )}
      {phase.kind === "failed" && (
        <Notice tone="error" title="OpenRouter isn't connected">
          {phase.message}
        </Notice>
      )}
      {phase.kind !== "working" && (
        <Link href="/settings/ai" className={`${ghostBtn} mt-4 inline-block`}>
          Back to AI settings
        </Link>
      )}
    </div>
  );
}
