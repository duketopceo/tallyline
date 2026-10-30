#!/bin/sh
# Tallyline one-line installer.
#   curl -fsSL https://tallyline.app/install.sh | sh
#
# Installs the @tallyline/cli release this file is pinned to. It never follows
# "latest": the version and the SHA-512 of its tarball are written into this file
# at release time by tools/install/pin.sh, and the download is refused when it
# does not match. Needs Node 20+ (never installs Node for you). No sudo.
#
# Options (after `sh -s --`):  --dry-run   show what would happen, change nothing
# Environment: TALLYLINE_PREFIX (default ~/.local) is where the `tallyline` command goes.
set -eu

PINNED_VERSION=""
PINNED_SHA512=""

say() { printf '%s\n' "$*"; }
die() { printf '\nSomething went wrong: %s\n' "$*" >&2; exit 1; }

dry=0
for a in "$@"; do
  case "$a" in
    --dry-run) dry=1 ;;
    -h|--help) say "Installs the Tallyline command-line tool. Add --dry-run to preview."; exit 0 ;;
    *) die "unknown option '$a'" ;;
  esac
done

if [ -z "$PINNED_VERSION" ] || [ -z "$PINNED_SHA512" ]; then
  die "this installer has not been pinned to a release yet, so it will not install anything.
Use instead:  npx @tallyline/cli setup"
fi

command -v node >/dev/null 2>&1 || die "Tallyline needs Node.js 20 or newer, and it is not installed.
Get it from https://nodejs.org (or on a Mac: brew install node), then run this again."
command -v npm >/dev/null 2>&1 || die "npm was not found. It comes with Node.js: https://nodejs.org"
major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$major" -ge 20 ] 2>/dev/null || die "Node.js $major is too old; Tallyline needs 20 or newer. Update from https://nodejs.org"

sha512_of() {
  if command -v sha512sum >/dev/null 2>&1; then sha512sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 512 "$1" | cut -d' ' -f1
  else die "no tool to check the download (need sha512sum or shasum)"; fi
}

prefix="${TALLYLINE_PREFIX:-$HOME/.local}"
say "Installing Tallyline $PINNED_VERSION into $prefix/bin"

if [ "$dry" = 1 ]; then
  say "Dry run: would download @tallyline/cli@$PINNED_VERSION, check it against the pinned checksum,"
  say "and install it under $prefix. Nothing was changed."
  exit 0
fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT INT TERM
( cd "$tmp" && npm pack "@tallyline/cli@$PINNED_VERSION" --silent >/dev/null 2>"$tmp/err" ) \
  || die "could not download @tallyline/cli@$PINNED_VERSION. $(tail -n 2 "$tmp/err" 2>/dev/null)"
tarball="$(ls "$tmp"/tallyline-cli-*.tgz 2>/dev/null | head -n 1)"
[ -n "$tarball" ] || die "the download was not where expected"

got="$(sha512_of "$tarball")"
if [ "$got" != "$PINNED_SHA512" ]; then
  die "the download does not match the checksum this installer expects, so nothing was installed.
Expected ${PINNED_SHA512%"${PINNED_SHA512#????????????}"}...  got ${got%"${got#????????????}"}...
This can mean a corrupted download or a tampered package. Try again; if it repeats, tell us."
fi

npm install -g --prefix "$prefix" --silent "$tarball" >/dev/null 2>"$tmp/err" \
  || die "npm could not install it. $(tail -n 2 "$tmp/err" 2>/dev/null)"

say ""
say "Tallyline $PINNED_VERSION is installed."
case ":$PATH:" in
  *":$prefix/bin:"*) ;;
  *)
    say ""
    say "One more thing: your terminal does not look in $prefix/bin yet. Add this line to"
    say "~/.zshrc (Mac) or ~/.bashrc (Linux), then open a new terminal window:"
    say ""
    say "  export PATH=\"$prefix/bin:\$PATH\""
    ;;
esac
say ""
say "Next, run:  tallyline setup"
