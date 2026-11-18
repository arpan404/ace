# Releasing the desktop app

Every installed app checks GitHub releases and updates itself from them
([ADR 0091](adr/0091-desktop-auto-update.md)).

**A release normally starts from a tag.** Pushing `vX.Y.Z` or `ace-X.Y.Z-beta-N` runs
`.github/workflows/release.yml` on ace's own runners: it builds every platform, writes the
notes, deploys the cloud and publishes ([ADR 0188](adr/0188-tag-driven-release-pipeline.md);
runner setup in [release/runners.md](release/runners.md)). The rest of this page is the same
build done by hand on your Mac, which the pipeline's steps call.

## One-time setup

1. **GitHub CLI.** `brew install gh`, then `gh auth login` with access to `arpan404/ace`.
2. **Developer ID certificate** (skip it for `--unsigned` releases). In the Apple Developer
   portal, under Certificates, create a **Developer ID Application** certificate and install it
   in your login keychain. Apple Development and Apple Distribution certificates cannot sign
   apps distributed outside the App Store. If you have several, set
   `CSC_NAME="Developer ID Application: Your Name (TEAMID)"`.
3. **Notarization credentials** (with the certificate). Create an app-specific password at
   account.apple.com, then save a notarytool profile once:

   ```sh
   xcrun notarytool store-credentials ace-notary \
     --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
   export APPLE_KEYCHAIN_PROFILE=ace-notary   # in your shell profile
   ```

   An App Store Connect API key works too (`APPLE_API_KEY`, `APPLE_API_KEY_ID`,
   `APPLE_API_ISSUER`).

4. Check everything with `bun run release:doctor`.

## Make a release

Versions are semver, 0.x included. The version you pass must match `apps/desktop/package.json`,
so bump it in a PR first. `0.1.0-preview.1` publishes a prerelease, which only preview
installs move to.

```sh
git switch main && git pull           # release from a pushed commit
bun run release:doctor
bun run release:build 0.0.3 --with-daemon
open dist/releases/v0.0.3             # try the dmg before publishing
bun run release:publish 0.0.3 --notes-file notes.md   # or: --draft to review it first
```

`release:build` packages the app for this Mac's architecture, signs and notarizes it, and
verifies it (`codesign`, `spctl`, the stapled ticket). It stages the dmg, the zip that updates
install from, their blockmaps, `latest-mac.yml`, `ace-data.json` and `SHA256SUMS` under
`dist/releases/v<version>`. `ace-data.json` holds the data formats the build reads (ADR 0177):
installed apps check it before they offer a switch to an older release. `bun run release:data`
prints it for this tree, or `bun run release:data <checkout>` for another (an older tag's, with
`bun install` run in it); that command uploads nothing.

`release:publish` checks that the staged files are unchanged and that GitHub has the commit.
It uploads everything to a draft release tagged `v<version>` at that commit, then publishes
it. Release notes come from `--notes-file notes.md`, or are generated from merged PRs.

To include standalone CLI archives (`ace update` on installs from `install.sh`), pass
`--with-daemon` to `release:build`. Set `ACE_RELEASE_PUBLIC_KEY_FILE` and
`ACE_RELEASE_PRIVATE_KEY_FILE` (kept outside the repository), and run it on Node 26.12.1. See
[tools/release](../tools/release/README.md). Always pass it: apps from before this updater
(0.0.2 and earlier) check those signed manifests, and offer the download when they find one.

## Beta builds

A beta is a signed macOS arm64 build of a commit on `origin/main`, published as a GitHub
prerelease tagged `ace-<X.Y.Z>-beta-<N>` (`ace-0.0.24-beta-1`) and never marked latest
([ADR 0177](adr/0177-beta-release-line.md)). Apps on the Beta line pick it up.

```sh
bun run release:doctor                 # a beta is always signed and notarized
bun run release:beta build             # works out the tag; stages dist/releases/<tag>
                                       # --version 0.1.0 previews a later version
bun run release:beta publish <tag> --notes-file notes.md
```

`build` refuses another platform or architecture, a dirty tree and a commit not on
`origin/main`. A beta previews the next version: the patch after `apps/desktop/package.json`
(0.0.23 → 0.0.24), or a later `--version`. `N` is one more than the highest beta of that
version on GitHub, across days. It builds the app as `X.Y.Z-beta.<N>` (`0.0.24-beta.1`), titled
`ace 0.0.24 beta 1`, without touching `package.json`, with a peeled corner on the Dock icon. `publish` uploads a draft prerelease, then
publishes it.

## What people see

- An update button appears beside the Settings gear once a newer release is found. The app
  checks 15 seconds after launch and then every 60–90 seconds; **Check for Updates…** in
  the app menu and **Settings › General › Updates** check now. The Settings row also
  downloads the update and restarts into it.
- When a newer release exists, the button shows a download icon with a dot. Hovering it
  shows what changed in every release since the installed one. Clicking downloads it, with
  progress around the icon. "Update downloaded" says when it's ready.
- Clicking again asks to restart. ace waits for running agents to finish (up to 5 minutes),
  then restarts into the new version. If agents are still working, nothing is interrupted
  and the update stays ready.
- Quitting ace also installs a downloaded update.
- From a terminal: `ace update check` and `ace update apply`. Inside the desktop app's `ace`,
  `apply` asks the app to update itself, bundled daemon included.
- From another client: **Settings › Fleet** shows each machine's update and updates one
  machine or all of them, when idle or now ([ADR 0113](adr/0113-remote-updates.md)). Each
  machine installs its own platform's release: the desktop app through the same restart, a
  standalone daemon through `ace update apply`. Linux deb and tar.gz installs, and unsigned Mac
  builds, are pointed to the release page instead.
- An unsigned build cannot replace itself on macOS. Clicking the button opens the release
  page instead.
- The changes come from the GitHub release notes, so write them for people:
  `--generate-notes` lists merged PR titles.
- **Settings › General › Updates** picks the Stable or Beta line. Beta offers the newest
  release of either line. Going back to an older release (Beta → Stable) is offered only when
  that release reads every data format this install holds; otherwise Settings says why. A beta
  build shows the word Beta at the sidebar's foot.

## Linux packages

Linux packages are built per architecture in a Debian 12 container on a Linux host of that
architecture, so they run on Ubuntu 24.04+, Debian 12+, Fedora and Arch ([ADR 0093](adr/0093-linux-release.md)).
The release pipeline does this on omarchy (`tools/release/linux/pipeline-build.sh`, arm64
under emulation); locally, follow [tools/release](../tools/release/README.md). Either way it is
the same `release:build`, which stages the AppImage, deb, tar.gz, `latest-linux.yml` or
`latest-linux-arm64.yml` and `SHA256SUMS`, unsigned. By hand, publish them with the Mac's build
of the same commit:

```sh
# Each Linux host's dist/releases/v0.0.3, copied to the Mac:
bun run release:publish 0.0.3 --include <linux-x64 staged folder> \
  --include <linux-arm64 staged folder>
```

`release:publish` refuses builds of different versions or commits and re-checks every file's
hash. The AppImage updates itself; deb and tar.gz installs are offered the release page.

## Notes

- The first release built with this updater is the first one installed apps can update to
  in place. Apps from before it (0.0.2 and earlier) show "is available" with Download.
- One build covers one architecture, the Mac's own. Intel Macs update in place only from a
  release built on an Intel Mac; otherwise they are offered the download.
- To test an update end to end, install release N, publish N+1 (a `--draft` is not seen), then
  use Check for Updates in the installed app.
- Release builds write logs to `~/Library/Logs/ace/desktop.jsonl`; updater lines start with
  `updater:`.
