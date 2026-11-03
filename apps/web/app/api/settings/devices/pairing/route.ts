import { proxy } from "@/lib/proxy";
import { pairingQrSvg } from "@/lib/pairing-qr";

const NO_STORE = { "cache-control": "no-store" };

// Mints the five-minute code and hands back a QR for the same URL, so the
// phone can scan instead of typing `tlpair_…`. Any failure is the API's to
// describe: only a 201 with a pairingUrl is rewritten, and anything else is
// passed through untouched.
export async function POST(req: Request) {
  const res = await proxy(req, "/devices/pairing");
  if (res.status !== 201) return res;

  const data = (await res.json().catch(() => null)) as { pairingUrl?: unknown } | null;
  const pairingUrl = typeof data?.pairingUrl === "string" ? data.pairingUrl : null;
  if (!pairingUrl) return Response.json(data, { status: 201, headers: NO_STORE });

  return Response.json(
    { ...data, qrSvg: await pairingQrSvg(pairingUrl) },
    { status: 201, headers: NO_STORE },
  );
}
