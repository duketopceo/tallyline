#!/usr/bin/env bash
# Source this, then run `vhs demo.tape`. Builds nothing; run `pnpm build` first.
# Everything here is fake: a throwaway server on 127.0.0.1:4010, a throwaway HOME.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DEMO_HOME="$(mktemp -d)/sam"
mkdir -p "$DEMO_HOME"
export DEMO_BIN="$(mktemp -d)"
printf '#!/usr/bin/env bash\nexec node "%s/../../dist/index.js" "$@"\n' "$here" >"$DEMO_BIN/tallyline"
chmod +x "$DEMO_BIN/tallyline"
node "$here/server.mjs" >/dev/null 2>&1 &
export DEMO_SERVER_PID=$!
trap 'kill $DEMO_SERVER_PID 2>/dev/null || true' EXIT
sleep 0.5
export HOME="$DEMO_HOME" PATH="$DEMO_BIN:$PATH" TALLYLINE_KEYCHAIN=off PS1='$ '
unset TALLYLINE_TOKEN TALLYLINE_API_URL TALLYLINE_WORKSPACE
