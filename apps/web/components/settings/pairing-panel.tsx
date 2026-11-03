"use client";

import { useState } from "react";
import { ErrorLine, Panel, SecretReveal, errorMessage, primaryBtn } from "./ui";

export function PairingPanel() {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function create() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/devices/pairing", { method: "POST" });
      if (!res.ok) {
        setError(await errorMessage(res, "Could not create a pairing code."));
        return;
      }
      const data = (await res.json()) as { code: string };
      setCode(data.code);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="max-w-xl p-4">
      <Panel
        id="pair-phone"
        title="Pair a phone"
        hint="Create a single-use code, then enter it in the Tallyline app on your phone. The code expires after five minutes."
      >
        <ErrorLine message={error} />
        <button type="button" onClick={create} disabled={pending} className={`${primaryBtn} mt-4`}>
          {pending ? "Creating..." : "Create pairing code"}
        </button>
        {code && (
          // keyed by value: a re-minted code gets a fresh five-minute reveal
          // window, and a failed mint leaves the previous code on screen
          <SecretReveal
            key={code}
            label="pairing code"
            value={code}
            onDismiss={() => setCode(null)}
          />
        )}
      </Panel>
    </div>
  );
}
