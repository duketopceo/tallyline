import QRCode from "qrcode";

// The phone scans `tallyline://pair?server=…&code=…`, so the QR carries the
// API's pairingUrl rather than the bare code: scanning and pasting are then
// the same redemption path, and a self-hosted server suggestion survives.
// Server-only: the SVG is generated in the bridge route, so `qrcode` never
// reaches the client bundle.
export async function pairingQrSvg(pairingUrl: string): Promise<string> {
  return QRCode.toString(pairingUrl, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    width: 208,
    // QR readers need dark modules on light ones; the web app has a dark
    // theme, so the colours are fixed rather than inherited.
    color: { dark: "#000000ff", light: "#ffffffff" },
  });
}
