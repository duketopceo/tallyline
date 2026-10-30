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
