import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { http2Apns } from "./apns.js";
import { parseHandleKey } from "./protocol.js";
import { createRelay } from "./relay.js";

// Off unless configured: without every variable below the relay refuses to
// start. Running the public relay with the App Store key is the maintainer's
// call (see docs/push.md).

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`push-relay: ${name} is not set; refusing to start`);
    process.exit(1);
  }
  return v;
}

const handleKey = parseHandleKey(need("PUSH_RELAY_HANDLE_KEY"));
const pem = process.env.APNS_PRIVATE_KEY_FILE
  ? readFileSync(process.env.APNS_PRIVATE_KEY_FILE, "utf8")
  : need("APNS_PRIVATE_KEY");
const apns = http2Apns({
  teamId: need("APNS_TEAM_ID"),
  keyId: need("APNS_KEY_ID"),
  privateKeyPem: pem,
  topic: need("APNS_TOPIC"),
});
const trustProxy = process.env.PUSH_RELAY_TRUST_PROXY === "1";

const handler = createRelay({
  handleKey,
  apns,
  // one JSON line per event; no tokens, handles or payloads are logged
  log: (l) => console.log(JSON.stringify({ t: new Date().toISOString(), ...l })),
  clientIp: (req: IncomingMessage) => {
    const xff = req.headers["x-forwarded-for"];
    if (trustProxy && typeof xff === "string") return xff.split(",")[0]!.trim();
    return req.socket.remoteAddress ?? "?";
  },
});

const port = Number(process.env.PORT ?? "8790");
const server = createServer((req, res) => void handler(req, res));
server.listen(port, () => console.log(`push-relay listening on :${port}`));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close();
    apns.close();
  });
}
