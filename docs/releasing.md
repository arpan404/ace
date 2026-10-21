# Releasing the desktop app

Releases are built, signed and notarized on your Mac, then published as a GitHub release.
Every installed app checks GitHub releases and updates itself from them
([ADR 0091](adr/0091-desktop-auto-update.md)).

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
install from, their blockmaps, `latest-mac.yml` and `SHA256SUMS` under `dist/releases/v<version>`.

`release:publish` checks that the staged files are unchanged and that GitHub has the commit.
It uploads everything to a draft release tagged `v<version>` at that commit, then publishes
it. Release notes come from `--notes-file notes.md`, or are generated from merged PRs.

To include standalone CLI archives (`ace update` on installs from `install.sh`), pass
`--with-daemon` to `release:build`. Set `ACE_RELEASE_PUBLIC_KEY_FILE` and
`ACE_RELEASE_PRIVATE_KEY_FILE` (kept outside the repository), and run it on Node 24.13.0. See
[tools/release](../tools/release/README.md). Always pass it: apps from before this updater
(0.0.2 and earlier) check those signed manifests, and offer the download when they find one.

## What people see

- An update button sits beside the Settings gear. Clicking it checks for updates. The app
  also checks 15 seconds after launch and every 30 minutes; **Check for Updates…** in the
  app menu checks now.
- When a newer release exists, the button shows a download icon with a dot. Hovering it
  shows what changed in every release since the installed one. Clicking downloads it, with
  progress around the icon. "Update downloaded" says when it's ready.
- Clicking again asks to restart. ace waits for running agents to finish (up to 5 minutes),
  then restarts into the new version. If agents are still working, nothing is interrupted
  and the update stays ready.
- Quitting ace also installs a downloaded update.
- From a terminal: `ace update check` and `ace update apply`. Inside the desktop app's `ace`,
  `apply` asks the app to update itself, bundled daemon included.
- An unsigned build cannot replace itself on macOS. Clicking the button opens the release
  page instead.
- The changes come from the GitHub release notes, so write them for people:
  `--generate-notes` lists merged PR titles.

## Linux packages

Linux packages are built per architecture in a Debian 11 container on a Linux host of that
architecture, so they run on Ubuntu 20.04+ and Debian 11+ ([ADR 0093](adr/0093-linux-release.md)).
`.github/workflows/release.yml` does this on GitHub's x64 and arm64 runners and uploads each
staged folder as `ace-desktop-linux-<arch>`; locally, follow
[tools/release](../tools/release/README.md). Either way it is the same `release:build`, which
stages the AppImage, deb, tar.gz, `latest-linux.yml` or `latest-linux-arm64.yml` and
`SHA256SUMS`, unsigned. Publish them with the Mac's build of the same commit:

```sh
gh run download <run-id> --pattern 'ace-desktop-linux-*' --dir dist/linux
bun run release:publish 0.0.3 --include dist/linux/ace-desktop-linux-x64 \
  --include dist/linux/ace-desktop-linux-arm64
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
