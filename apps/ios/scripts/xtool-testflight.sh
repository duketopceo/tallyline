#!/usr/bin/env bash
# Build + sign + upload Tallyline to TestFlight entirely from omarchy (xtool + rcodesign +
# the mini's altool). Working path proven 2026-10-30 — the mini's beta Xcode is never needed.
set -euo pipefail
cd "$(dirname "$0")/.."
WORK=/tmp/tallyline-sign
SIGN=$WORK/app
mkdir -p "$SIGN"

echo "→ xtool release build"
xtool dev build -c release --sign --ipa

echo "→ fetch App Store profile + dist cert from the mini"
scp -q mini:/var/folders/sy/lfhg70sd2h93wb9936z4l_fh0000gn/T/tmp.XoD7hGlu1g/dist.key mini:/var/folders/sy/lfhg70sd2h93wb9936z4l_fh0000gn/T/tmp.XoD7hGlu1g/dist_match.cer mini:/var/folders/sy/lfhg70sd2h93wb9936z4l_fh0000gn/T/tmp.XoD7hGlu1g/tallyline-appstore.mobileprovision "$WORK/"
cat "$WORK/dist_match.cer" "$WORK/dist.key" > "$WORK/dist.pem"
base64 -d "$WORK/tallyline-appstore.mobileprovision" > "$WORK/profile-bin.mobileprovision"

echo "→ unpack, fix plist, icons, profile"
rm -rf "$SIGN" && mkdir -p "$SIGN"
(cd "$SIGN" && unzip -q "$OLDPWD/xtool/tallyline_ios.ipa")
cp "$WORK/profile-bin.mobileprovision" "$SIGN/Payload/tallyline_ios.app/embedded.mobileprovision"
cp App.entitlements "$SIGN/ent.plist"
ssh mini 'mkdir -p /tmp/iconfix && cd /tmp/iconfix && rsync -a ~/release/tallyline/apps/ios/Resources/Assets.xcassets . && xcrun actool --compile . --platform iphoneos --minimum-deployment-target 26.0 --app-icon AppIcon --output-partial-info-plist actool.plist Assets.xcassets >/dev/null 2>&1'
scp -q mini:/tmp/iconfix/Assets.car mini:/tmp/iconfix/actool.plist "$SIGN/Payload/tallyline_ios.app/"

python3 - "$SIGN" <<'PY'
import plistlib,sys,os
d=os.path.join(sys.argv[1],'Payload/tallyline_ios.app')
# sized icons beside the bundle (named-file fallback Apple still validates)
import subprocess
subprocess.run(['uv','run','--with','pillow','python','-c','''
from PIL import Image
img=Image.open("Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png")
import sys,os
for n,s in [("AppIcon60x60@2x.png",120),("AppIcon60x60@3x.png",180),("AppIcon76x76.png",76),("AppIcon76x76@2x.png",152),("AppIcon83.5x83.5@2x.png",167),("AppIcon1024x1024.png",1024)]:
    img.resize((s,s),Image.LANCZOS).save(os.path.join(sys.argv[1],n))
    if "76x76" in n or "83.5" in n:
        img.resize((s,s),Image.LANCZOS).save(os.path.join(sys.argv[1],n.replace(".png","~ipad.png")))
''', d],check=True)
p=os.path.join(d,'Info.plist'); pl=plistlib.load(open(p,'rb'))
pl.update({'CFBundleIdentifier':'app.tallyline.ios','MinimumOSVersion':'26.0',
 'DTPlatformName':'iphoneos','DTPlatformVersion':'26.0','DTSDKName':'iphoneos26.0',
 'DTSDKBuild':'23A339','DTXcode':'2600','DTXcodeBuild':'17A321',
 'DTCompiler':'com.apple.compilers.llvm.clang.1_0','BuildMachineOSBuild':'25A362',
 'CFBundleIconName':'AppIcon'})
plistlib.dump(pl,open(p,'wb'))
PY

echo "→ sign"
(cd "$SIGN" && rcodesign sign --pem-file "$WORK/dist.pem" --entitlements-xml-file ent.plist Payload/tallyline_ios.app)
(cd "$SIGN" && zip -qr "$WORK/tallyline-dist.ipa" Payload)

echo "→ upload"
scp -q "$WORK/tallyline-dist.ipa" mini:/tmp/
ssh mini 'source ~/release/testflight.env && xcrun altool --upload-app -f /tmp/tallyline-dist.ipa -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" --apple-id 6828720271'
