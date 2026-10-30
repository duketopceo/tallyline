#!/bin/sh
# Release step: pin install.sh to a PUBLISHED @tallyline/cli version.
#   tools/install/pin.sh 2.1.0
# Downloads the published tarball, computes its SHA-512, and writes both into
# install.sh. Run after the npm publish, then commit install.sh. Needs network.
set -eu
v="${1:?usage: pin.sh <version>}"
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
( cd "$tmp" && npm pack "@tallyline/cli@$v" --silent >/dev/null )
f="$(ls "$tmp"/tallyline-cli-*.tgz | head -n 1)"
if command -v sha512sum >/dev/null 2>&1; then sum="$(sha512sum "$f" | cut -d' ' -f1)"; else sum="$(shasum -a 512 "$f" | cut -d' ' -f1)"; fi
sed -i.bak -e "s/^PINNED_VERSION=.*/PINNED_VERSION=\"$v\"/" -e "s/^PINNED_SHA512=.*/PINNED_SHA512=\"$sum\"/" "$here/install.sh"
rm -f "$here/install.sh.bak"
echo "pinned install.sh to $v ($sum)"
