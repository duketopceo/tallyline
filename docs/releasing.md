# Releasing the npm packages

`@tallyline/mcp-server` and `@tallyline/cli` publish from
`.github/workflows/publish.yml` when a `v*` tag is pushed, with npm provenance.

One-time owner steps (not done by the repo):

1. Create the `tallyline` npm org/scope (or claim the scope with a user) and
   confirm `@tallyline/mcp-server` and `@tallyline/cli` are free.
2. Preferred: after the first publish, configure each package's npm
   "Trusted Publisher" (GitHub repo `duketopceo/tallyline`, workflow
   `publish.yml`, environment `npm`). The first publish of a new package needs a token.
3. First publish: create a granular automation token limited to the
   `@tallyline` scope, store it as the `NPM_TOKEN` secret of a GitHub
   environment named `npm` (add required reviewers), then delete it once trusted
   publishing works.
4. Bump `version` in both `package.json` files plus `VERSION` in
   `tools/cli/src/cli.ts` and `SERVER_INFO` in `apps/mcp-server/src/server.ts`,
   merge, then `git tag vX.Y.Z && git push origin vX.Y.Z`. The workflow fails if
   the tag and package versions differ.

Check after release: `npm view @tallyline/mcp-server dist.attestations.url` and
`npx -y @tallyline/mcp-server --help`.

## Images, installer and one-click deploy (stage S2)

`tallyline setup` and `tallyline update` run published images, not a source build.

- **Images.** The `images` job in `publish.yml` pushes
  `ghcr.io/duketopceo/tallyline-api:<version>` and `...-web:<version>` on every `v*` tag.
  One-time owner step: after the first run, set both packages to public
  (GitHub > Packages > package settings), or fresh installs cannot pull them.
- **Installer.** `tools/install/install.sh` ships unpinned and refuses to install
  until pinned. After the npm publish succeeds, run `tools/install/pin.sh X.Y.Z`
  (it downloads the published tarball, writes the version and its SHA-512 into the
  script) and commit the result. Do not host `install.sh` anywhere before it is pinned
  and `@tallyline/cli@X.Y.Z` is confirmed on npm (`npm view @tallyline/cli version`).
- **Homebrew and single-file binaries.** Not shipped yet: needs a tap repository
  and a binary spike (Node single-executable vs bun compile on macOS arm64/x64 and
  Linux x64/arm64). The npm route above is the supported one meanwhile.
- **Railway template.** See `deploy/railway/README.md` for the publishing steps.

## iOS (TestFlight)

- **Every PR touching `apps/ios`** runs `.github/workflows/ios.yml`: core tests on
  Linux, then on a `macos-26` runner the core tests, `xcodegen`, an unsigned
  simulator `build-for-testing` (app plus UI tests) and an unsigned Release build
  for the device SDK. No secrets are used.
- **Uploads** run `.github/workflows/ios-release.yml`, by hand (Actions → ios-release →
  Run workflow, with a marketing version) or by pushing an `ios-vX.Y` tag. The job
  waits for approval on the `testflight` environment, then runs
  `apps/ios/scripts/testflight.sh` and keeps the build's dSYMs as a 90-day artifact.

One-time owner setup:

1. Settings → Environments → New environment `testflight`; add yourself as a
   required reviewer and limit it to `main` and `ios-v*` tags.
2. Add the environment secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`, `APPLE_TEAM_ID` and
   `ASC_KEY_P8_BASE64` (`base64 -i AuthKey_<id>.p8 | pbcopy`). Use an App Store
   Connect API key with the App Manager role.
3. Optional: add the repository secret `PRIVACY_DENYLIST` (one term per line) so the
   privacy scan also checks names specific to you.

`apps/ios/scripts/xtool-testflight.sh` is a fallback from a Linux machine; it reads
its host, signing directory and app ID from the environment.
