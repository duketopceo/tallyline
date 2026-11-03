"use client";

import { useState } from "react";
import { ErrorLine, Panel, SecretReveal, errorMessage, primaryBtn } from "./ui";

type Minted = { code: string; qrSvg?: string };

export function PairingPanel() {
  const [minted, setMinted] = useState<Minted | null>(null);
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
      const data = (await res.json().catch(() => null)) as { code?: unknown; qrSvg?: unknown } | null;
      if (typeof data?.code !== "string") {
        setError("The server sent an unexpected response. Try again.");
        return;
      }
      setMinted(
        typeof data.qrSvg === "string"
          ? { code: data.code, qrSvg: data.qrSvg }
          : { code: data.code },
      );
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
        hint="Create a single-use code, then scan the code below or type it in the Tallyline app on your phone. It expires after five minutes."
      >
        <ErrorLine message={error} />
        <button type="button" onClick={create} disabled={pending} className={`${primaryBtn} mt-4`}>
          {pending ? "Creating..." : "Create pairing code"}
        </button>
        {minted && (
          // keyed by value: a re-minted code gets a fresh five-minute reveal
          // window and a fresh QR, and a failed mint leaves both on screen
          <div key={minted.code}>
            {minted.qrSvg && (
              // the SVG carries its own light-theme quiet zone, so the page
              // theme never has to fight a scanner for contrast
              <div className="mt-4 w-fit overflow-hidden rounded-md" data-testid="pairing-qr">
                <div aria-hidden dangerouslySetInnerHTML={{ __html: minted.qrSvg }} />
                <p className="sr-only">QR code containing the pairing link</p>
              </div>
            )}
            <SecretReveal
              label="pairing code"
              value={minted.code}
              onDismiss={() => setMinted(null)}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}
