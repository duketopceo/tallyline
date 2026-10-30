#!/usr/bin/env bash
# Writes build/Info.xcode.plist, the Xcode copy of Info.plist with build-setting variables
# (Info.plist itself stays xtool-friendly). project.yml points the Tallyline target at it, so every
# xcodebuild path (testflight.sh, CI) runs this before `xcodegen generate`.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
cp Info.plist build/Info.xcode.plist
for kv in "CFBundleIdentifier:\$(PRODUCT_BUNDLE_IDENTIFIER)" "CFBundleExecutable:\$(EXECUTABLE_NAME)" \
          "CFBundleName:\$(PRODUCT_NAME)" "CFBundlePackageType:APPL" \
          "CFBundleShortVersionString:\$(MARKETING_VERSION)" "CFBundleVersion:\$(CURRENT_PROJECT_VERSION)"; do
  /usr/bin/plutil -replace "${kv%%:*}" -string "${kv#*:}" build/Info.xcode.plist
done
