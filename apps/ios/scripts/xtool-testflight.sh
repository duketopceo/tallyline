#!/usr/bin/env bash
# Fallback TestFlight path from a Linux machine: xtool builds, rcodesign signs,
# and a Mac you can ssh to compiles the icon catalog and runs altool.
# The supported path is .github/workflows/ios-release.yml; use this only when
# CI is unavailable.
#
# Everything machine-specific comes from the environment. Nothing personal
# (host names, key paths, account IDs) belongs in this file: the repo is public.
#
#   MAC_HOST          ssh destination of a Mac with Xcode (an alias from ~/.ssh/config)
#   SIGNING_DIR       directory on MAC_HOST holding dist.key, dist.cer and
#                     appstore.mobileprovision (base64)
#   MAC_ENV_FILE      file on MAC_HOST that exports ASC_KEY_ID and ASC_ISSUER_ID
#   ASC_APP_ID        numeric App Store Connect app ID
# shellcheck disable=SC2029  # remote paths are expanded locally on purpose
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "xtool-testflight: $*" >&2; exit 1; }
: "${MAC_HOST:?Set MAC_HOST (ssh alias of a Mac with Xcode)}"
: "${SIGNING_DIR:?Set SIGNING_DIR (directory on MAC_HOST with dist.key, dist.cer, appstore.mobileprovision)}"
: "${MAC_ENV_FILE:?Set MAC_ENV_FILE (file on MAC_HOST exporting ASC_KEY_ID and ASC_ISSUER_ID)}"
: "${ASC_APP_ID:?Set ASC_APP_ID (numeric App Store Connect app ID)}"
[[ "$ASC_APP_ID" =~ ^[0-9]+$ ]] || die "ASC_APP_ID must be numeric"
for tool in xtool rcodesign uv scp ssh zip unzip; do
  command -v "$tool" >/dev/null 2>&1 || die "missing tool: $tool"
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SIGN="$WORK/app"
REMOTE_TMP="/tmp/tallyline-iconfix-$$"

echo "→ xtool release build"
xtool dev build -c release --sign --ipa

echo "→ fetch distribution certificate and App Store profile"
scp -q "$MAC_HOST:$SIGNING_DIR/dist.key" "$MAC_HOST:$SIGNING_DIR/dist.cer" \
  "$MAC_HOST:$SIGNING_DIR/appstore.mobileprovision" "$WORK/"
cat "$WORK/dist.cer" "$WORK/dist.key" > "$WORK/dist.pem"
chmod 600 "$WORK/dist.key" "$WORK/dist.pem"
base64 -d "$WORK/appstore.mobileprovision" > "$WORK/profile.mobileprovision"

echo "→ unpack, embed profile, compile icons"
mkdir -p "$SIGN"
(cd "$SIGN" && unzip -q "$OLDPWD/xtool/tallyline_ios.ipa")
APP="$SIGN/Payload/tallyline_ios.app"
cp "$WORK/profile.mobileprovision" "$APP/embedded.mobileprovision"
cp App.entitlements "$SIGN/ent.plist"
ssh "$MAC_HOST" "mkdir -p '$REMOTE_TMP'"
scp -qr Resources/Assets.xcassets "$MAC_HOST:$REMOTE_TMP/"
ssh "$MAC_HOST" "cd '$REMOTE_TMP' && xcrun actool --compile . --platform iphoneos \
  --minimum-deployment-target 26.0 --app-icon AppIcon \
  --output-partial-info-plist actool.plist Assets.xcassets >/dev/null"
scp -q "$MAC_HOST:$REMOTE_TMP/Assets.car" "$MAC_HOST:$REMOTE_TMP/actool.plist" "$APP/"

echo "→ sized icons and Info.plist fields App Store validation checks"
uv run --with pillow python - "$APP" <<'PY'
import os, plistlib, sys
from PIL import Image
app = sys.argv[1]
img = Image.open("Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png")
for name, size in [("AppIcon60x60@2x.png", 120), ("AppIcon60x60@3x.png", 180),
                   ("AppIcon76x76.png", 76), ("AppIcon76x76@2x.png", 152),
                   ("AppIcon83.5x83.5@2x.png", 167), ("AppIcon1024x1024.png", 1024)]:
    out = img.resize((size, size), Image.LANCZOS)
    out.save(os.path.join(app, name))
    if "76x76" in name or "83.5" in name:
        out.save(os.path.join(app, name.replace(".png", "~ipad.png")))
path = os.path.join(app, "Info.plist")
with open(path, "rb") as f:
    pl = plistlib.load(f)
pl.update({"CFBundleIdentifier": "app.tallyline.ios", "MinimumOSVersion": "26.0",
           "DTPlatformName": "iphoneos", "DTPlatformVersion": "26.0", "DTSDKName": "iphoneos26.0",
           "DTSDKBuild": "23A339", "DTXcode": "2600", "DTXcodeBuild": "17A321",
           "DTCompiler": "com.apple.compilers.llvm.clang.1_0", "BuildMachineOSBuild": "25A362",
           "CFBundleIconName": "AppIcon"})
with open(path, "wb") as f:
    plistlib.dump(pl, f)
PY

echo "→ sign"
(cd "$SIGN" && rcodesign sign --pem-file "$WORK/dist.pem" --entitlements-xml-file ent.plist Payload/tallyline_ios.app)
(cd "$SIGN" && zip -qr "$WORK/tallyline-dist.ipa" Payload)

echo "→ upload"
scp -q "$WORK/tallyline-dist.ipa" "$MAC_HOST:$REMOTE_TMP/"
ssh "$MAC_HOST" "source '$MAC_ENV_FILE' && xcrun altool --upload-app -f '$REMOTE_TMP/tallyline-dist.ipa' -t ios \
  --apiKey \"\$ASC_KEY_ID\" --apiIssuer \"\$ASC_ISSUER_ID\" --apple-id '$ASC_APP_ID'; rc=\$?; rm -rf '$REMOTE_TMP'; exit \$rc"
echo "Done. Processing in App Store Connect usually takes 10 to 30 minutes."
