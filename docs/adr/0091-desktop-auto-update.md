# 0091: Desktop auto-update through electron-updater and GitHub releases

Status: accepted. Date: 2026-10-18. Completes the update follow-up of ADR 0054; the standalone
daemon's updater (ADR 0041) is unchanged.

## Context

The desktop app could only check the signed daemon manifest and link to the release page
(ADR 0054). Installing an update meant downloading a dmg by hand. Releases are built, signed
and notarized on the owner's Mac and published as GitHub releases. The app bundles its own
daemon, so updating the app also updates that daemon. A restart must never cut off running
agents (AGENTS.md priority 1).

## Decision

**Feed and installer.** The app uses `electron-updater` (pinned) with electron-builder's GitHub
provider on `arpan404/ace`. Only `desktop:package --full` writes the feed: `app-update.yml`
inside the app and `latest*.yml` beside the packages. Local builds never check for updates.
electron-updater checks each download's SHA-512 against the release's `latest*.yml`. On
macOS, Squirrel.Mac also accepts only an update signed by the running app's Developer ID. On
Windows, NSIS checks the publisher once the app is signed. The trust root is the GitHub
release and the OS code signature. The Ed25519 release authority still signs standalone
daemon archives (ADR 0041); the app no longer embeds that key for its own checks.

**Flow.** `UpdateController` (`apps/desktop/src/main/os/update-controller.ts`) is pure; the
electron-updater shell (`updates.ts`) loads lazily on the first check. One `UpdateStatus`
object carries the state, the version on offer, its release page, progress, release notes
and the last error.

The flow follows t3code's observed updater behaviour (clean-room: behaviour only, no code).

- **Checks:** 15 s after launch, then every 60–90 s (a minute plus a random offset, so
  installs don't ask the feed in step), and on request from the app menu or Settings ›
  General › Updates. A background check
  shows nothing until it finds a newer version, and its failures stay in the log. A
  person's check shows `checking`, then the result.
- **Download:** a found update is `available` until the person clicks to download it. While
  it downloads, its progress shows on the button. A failed download stays on offer with its
  error, ready to retry.
- **Release notes:** with `fullChangelog`, electron-updater returns the notes of every
  release newer than this one. `release-notes.ts` turns the feed's HTML into plain lines:
  six releases at most, eight lines each, with counts for the rest. A generated
  "by @someone in …/pull/985" becomes "(#985)". No HTML reaches the page.
- **Restart:** a downloaded update restarts after the person confirms. The restart drains
  the daemon this app started (ADR 0041's maintenance lease, up to 5 minutes), then stops
  the browser backend and the daemon, and calls `quitAndInstall`.
- **Work at the deadline:** if work remains, admission reopens and the update stays
  `downloaded` with an `install` error saying agents are still working. A daemon the app did
  not start (the CLI's, the login service's, a remote one) keeps running through the
  restart, so nothing waits for it.
- **Install on Quit:** quitting installs a downloaded update. Quitting already stops the
  app's daemon.
- **Squirrel.Mac:** it verifies the signature only after electron-updater's download resolves,
  so on macOS the shell waits for Squirrel's `update-downloaded` before reporting
  `downloaded`.
- **When the app can't install itself:** an ad-hoc signed macOS build (`codesign` shows no
  team) or a deb. The update is offered with `inPlace: false`, and a click opens its release
  page.

**Where it shows.** A button beside the Settings gear at the sidebar's foot, in the desktop
app only. Its icon follows the state:

- idle or up to date: check (spins while checking);
- `available`: download, with a dot;
- `downloading`: download, with a progress ring;
- `downloaded`: restart, with a check;
- `installing`: a spinner whose label says how many agents it waits for.

Hovering an update in hand opens a card with what changed in each newer release, and links to
GitHub. Toasts answer the menu's Check for Updates…, a finished download ("Update
downloaded"), a failed check started from the button, and a Restart that found agents still
working.

**CLI.** The desktop build writes `daemon/desktop-app.json` (the app's version) beside the
bundled daemon. When that marker is present, `ace update` (`tools/release/src/desktop-update.ts`)
defers to the app:

- `check` compares the app's version with the newest `v<semver>` GitHub release: stable for a
  stable install, previews too for a preview install, as `allowPrerelease` does.
- `apply` launches the app's executable with `--ace-update`. A running app receives it as a
  second instance. The app then checks, downloads and installs without asking, since the
  command was the person's request. The same drain applies.
- `recover` has nothing to do.

A standalone install has no marker and keeps ADR 0041's transactional updater. The shell runs
the app's executable directly, rather than through an `ace://` link, so a web page cannot
schedule a restart.

**Releases.** `bun run release:build <version>` (`apps/desktop/scripts/release.ts`):

- refuses an uncommitted checkout and an existing tag;
- requires a Developer ID and notarytool credentials, unless `--unsigned`;
- packages for the host architecture and verifies `codesign`, `spctl` and the stapled ticket;
- stages the files with their SHA-256 under `dist/releases/v<version>`.

`--with-daemon` adds the signed standalone archives for both macOS targets, so standalone
`ace update` sees the release too. `bun run release:publish <version>` checks the staged
hashes and that GitHub has the built commit. It uploads to a draft release tagged at that
commit, then publishes it, so no app sees a half-uploaded release. Versions follow
`installableVersion`: 0.x is refused, as ADR 0041 does for the legacy app.

## Consequences

- Until a Developer ID exists, releases are `--unsigned`: installed Macs see the update and
  download it from the release page. Once the owner signs releases, they update in place.
- One local build covers one architecture. Intel Macs get an in-place update only from a
  release built on an Intel Mac.
- Publication of the full standalone set (install.sh, Homebrew, npx, Linux archives) stays with
  `tools/release`. It needs Linux native inputs.
- Tests cover the controller's states and effects, release file selection, credential
  detection, the release list choice, the CLI launching a real child process, and the sidebar
  button.
