#!/usr/bin/env bash
# Tests for install.sh with stub node/npm. No network, nothing installed.
# Run: bash tools/install/install.test.sh
set -uo pipefail
src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.sh"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
pass=0; failn=0
ok() { pass=$((pass+1)); printf 'ok   %s\n' "$1"; }
bad() { failn=$((failn+1)); printf 'FAIL %s\n     %s\n' "$1" "$2"; }
mkdir -p "$work/bin" "$work/home"
cat >"$work/bin/node" <<'S'
#!/bin/sh
echo "${STUB_NODE_MAJOR:-22}"
S
cat >"$work/bin/npm" <<'S'
#!/bin/sh
echo "npm $*" >>"$STUB_LOG"
case "$1" in
  pack) printf '%s' "${STUB_TARBALL:-good}" >tallyline-cli-1.2.3.tgz ;;
esac
exit 0
S
chmod +x "$work/bin/"*
good="$(printf good | sha512sum | cut -d' ' -f1)"
pinned() { sed -e "s/^PINNED_VERSION=.*/PINNED_VERSION=\"1.2.3\"/" -e "s/^PINNED_SHA512=.*/PINNED_SHA512=\"$good\"/" "$src" >"$work/install.sh"; }
runit() { HOME="$work/home" STUB_LOG="$work/log" PATH="$work/bin:/usr/bin:/bin" sh "$work/install.sh" "$@" 2>&1; }

: >"$work/log"; cp "$src" "$work/install.sh"
out="$(runit)"; rc=$?
{ [ $rc -ne 0 ] && grep -q "not been pinned" <<<"$out" && [ ! -s "$work/log" ]; } && ok "unpinned installer refuses and installs nothing" || bad "unpinned" "$out"

pinned; : >"$work/log"
out="$(runit --dry-run)"; rc=$?
{ [ $rc -eq 0 ] && grep -q "Nothing was changed" <<<"$out" && [ ! -s "$work/log" ]; } && ok "dry run changes nothing" || bad "dry run" "$out"

pinned; : >"$work/log"
out="$(runit)"; rc=$?
{ [ $rc -eq 0 ] && grep -q "npm install -g --prefix $work/home/.local" "$work/log" && grep -q "tallyline setup" <<<"$out"; } && ok "matching checksum installs and points to setup" || bad "install" "$out"
grep -q 'export PATH=' <<<"$out" && ok "PATH advice printed in plain words" || bad "PATH advice" "$out"

pinned; : >"$work/log"
out="$(STUB_TARBALL=evil runit)"; rc=$?
{ [ $rc -ne 0 ] && grep -q "does not match the checksum" <<<"$out" && ! grep -q "npm install" "$work/log"; } && ok "checksum mismatch aborts before install" || bad "mismatch" "$out"

pinned; : >"$work/log"
out="$(STUB_NODE_MAJOR=18 runit)"; rc=$?
{ [ $rc -ne 0 ] && grep -q "too old" <<<"$out"; } && ok "old Node explained" || bad "old node" "$out"

pinned; out="$(HOME="$work/home" PATH="/usr/bin:/bin" sh "$work/install.sh" 2>&1)"; rc=$?
if command -v node >/dev/null 2>&1 && [ "$(command -v node)" != "" ] && ! PATH=/usr/bin:/bin command -v node >/dev/null 2>&1; then
  { [ $rc -ne 0 ] && grep -q "not installed" <<<"$out"; } && ok "missing Node explained" || bad "no node" "$out"
else ok "missing Node (skipped: node on system PATH)"; fi

pinned; : >"$work/log"
out="$(HOME="$work/home" STUB_LOG="$work/log" PATH="$work/bin:$work/home/.local/bin:/usr/bin:/bin" sh "$work/install.sh" 2>&1)"
grep -q 'export PATH=' <<<"$out" && bad "no PATH advice when already on PATH" "$out" || ok "no PATH advice when already on PATH"

printf '\n%d passed, %d failed\n' "$pass" "$failn"; [ "$failn" -eq 0 ]
