import { proxy } from "@/lib/proxy";
import { pairingQrSvg } from "@/lib/pairing-qr";

const NO_STORE = { "cache-control": "no-store" };

const unreadable = (message: string) =>
  Response.json({ error: { code: "PAIRING_BRIDGE_FAILED", message } }, { status: 502, headers: NO_STORE });

// Mints the five-minute code and hands back a QR for the same URL, so the
// phone can scan instead of typing `tlpair_…`. Any failure is the API's to
// describe: only a 201 with a code is rewritten, and anything else is passed
// through untouched. An unreadable 201 becomes a 502 rather than a mint the
// page would show as empty.
export async function POST(req: Request) {
  let res: Response;
  try {
    res = await proxy(req, "/devices/pairing");
  } catch {
    return unreadable("could not reach the API");
  }
  if (res.status !== 201) return res;

  const data = (await res.json().catch(() => null)) as
    | { code?: unknown; pairingUrl?: unknown }
    | null;
  if (typeof data?.code !== "string") return unreadable("the API returned an unreadable mint");

  const pairingUrl = typeof data.pairingUrl === "string" ? data.pairingUrl : null;
  if (!pairingUrl) return Response.json(data, { status: 201, headers: NO_STORE });

  return Response.json(
    { ...data, qrSvg: await pairingQrSvg(pairingUrl) },
    { status: 201, headers: NO_STORE },
  );
}
