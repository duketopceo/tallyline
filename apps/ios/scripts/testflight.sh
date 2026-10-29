#!/usr/bin/env bash
# Build a signed Release archive and upload to TestFlight (internal).
# Run on Luke's Mac with release Xcode — not on Linux CI.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

die() { echo "testflight: $*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "This script must run on macOS with Xcode."

command -v xcodegen >/dev/null 2>&1 || die "Install XcodeGen (brew install xcodegen)."
command -v xcodebuild >/dev/null 2>&1 || die "Xcode command-line tools not found."
xcodebuild -version >/dev/null 2>&1 || die "xcodebuild failed — select a full Xcode install (xcode-select -s)."

: "${ASC_KEY_ID:?Set ASC_KEY_ID (App Store Connect API key ID)}"
: "${ASC_ISSUER_ID:?Set ASC_ISSUER_ID (App Store Connect issuer ID)}"
: "${ASC_KEY_PATH:?Set ASC_KEY_PATH (path to AuthKey_<ID>.p8)}"
: "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID (Apple Developer team ID)}"

[[ -f "$ASC_KEY_PATH" ]] || die "ASC_KEY_PATH is not a file: $ASC_KEY_PATH"

export DEVELOPMENT_TEAM="$APPLE_TEAM_ID"

BUILD_NUMBER="$(date -u +%Y%m%d%H%M%S)"
MARKETING_VERSION="${MARKETING_VERSION:-1.0}"
ARCHIVE="$ROOT/build/Tallyline.xcarchive"
EXPORT_DIR="$ROOT/build/export"
IPA="$EXPORT_DIR/Tallyline.ipa"

mkdir -p "$ROOT/build"

echo "→ Swift package tests (core targets only; UI targets need the iOS SDK)"
TALLYLINE_CORE_ONLY=1 swift test

echo "→ XcodeGen"
# Info.plist stays xtool-friendly (no build-setting variables); Xcode gets a copy with them.
bash scripts/xcode-plist.sh
xcodegen generate

AUTH_ARGS=(
  -allowProvisioningUpdates
  -authenticationKeyPath "$ASC_KEY_PATH"
  -authenticationKeyID "$ASC_KEY_ID"
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"
)

echo "→ Archive Release (build $BUILD_NUMBER, version $MARKETING_VERSION)"
xcodebuild \
  -project Tallyline.xcodeproj \
  -scheme Tallyline \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  archive \
  "${AUTH_ARGS[@]}" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  MARKETING_VERSION="$MARKETING_VERSION" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER"

# Keep this build's dSYMs: crashes can only be read against the dSYM of the exact build.
# Stops before upload so no build ships without its dSYMs.
DSYM_DEST="$HOME/tallyline-dsyms/${MARKETING_VERSION}-${BUILD_NUMBER}"
shopt -s nullglob
DSYMS=("$ARCHIVE"/dSYMs/*.dSYM)
shopt -u nullglob
[[ ${#DSYMS[@]} -gt 0 ]] || die "No .dSYM bundles in $ARCHIVE/dSYMs (needed to symbolicate crashes)."
mkdir -p "$DSYM_DEST"
cp -R "${DSYMS[@]}" "$DSYM_DEST/"
echo "→ dSYMs archived: $DSYM_DEST (${#DSYMS[@]} bundle(s))"

EXPORT_PLIST="$ROOT/build/ExportOptions.plist"
cp "$ROOT/ci/ExportOptions.plist" "$EXPORT_PLIST"
/usr/libexec/PlistBuddy -c "Add :teamID string $APPLE_TEAM_ID" "$EXPORT_PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :teamID $APPLE_TEAM_ID" "$EXPORT_PLIST"

rm -rf "$EXPORT_DIR"

echo "→ Export App Store IPA"
xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  "${AUTH_ARGS[@]}"

[[ -f "$IPA" ]] || die "Expected IPA at $IPA"

KEY_DIR="$HOME/.appstoreconnect/private_keys"
mkdir -p "$KEY_DIR"
DEST_KEY="$KEY_DIR/AuthKey_${ASC_KEY_ID}.p8"
if [[ "$(realpath "$ASC_KEY_PATH" 2>/dev/null || echo "$ASC_KEY_PATH")" != "$(realpath "$DEST_KEY" 2>/dev/null || echo "$DEST_KEY")" ]]; then
  cp "$ASC_KEY_PATH" "$DEST_KEY"
  chmod 600 "$DEST_KEY"
fi

echo "→ Upload to App Store Connect / TestFlight"
xcrun altool --upload-app -f "$IPA" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

echo "Done. Processing in App Store Connect usually takes 10–30 minutes."
echo "Archive: $ARCHIVE"
echo "IPA: $IPA"
