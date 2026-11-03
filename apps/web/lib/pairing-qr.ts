import QRCode from "qrcode";
import { tokens } from "@tallyline/silver-lining";

// The phone scans `tallyline://pair?server=…&code=…`, so the QR carries the
// API's pairingUrl rather than the bare code: scanning and pasting are then
// the same redemption path, and a self-hosted server suggestion survives.
//
// Colours are the light theme's ink on canvas, taken from the design tokens
// rather than a palette: a scanner needs dark modules on a light field no
// matter which theme the page is in, and the four-module margin is the quiet
// zone the spec requires. Server-only — the SVG is generated in the bridge
// route, so `qrcode` never reaches the client bundle.
export async function pairingQrSvg(pairingUrl: string): Promise<string> {
  return QRCode.toString(pairingUrl, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 4,
    width: 208,
    color: { dark: tokens.light.ink, light: tokens.light.canvas },
  });
}
