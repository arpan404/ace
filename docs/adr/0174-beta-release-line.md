# 0174: A beta release line in the same app, with a guarded way back to stable

Date: 2026-11-16. Status: accepted. Decided by: the owner. Amends
[ADR 0091](0091-desktop-auto-update.md).

## Context

Every build of `main` that people can install is a stable release (`v<semver>` on
`arpan404/ace`). The owner wants builds of `main` between stable releases, installed the same way,
without cutting a stable version each time.

Moving between lines is the risky part. An older daemon refuses a database newer than its own
schema (`apps/daemon/src/migrations.ts`), and an older home format makes it exit 65 (ADR 0081).
A person who installs a beta that adds a migration, then goes back to stable, would have a
daemon that cannot start.

## Decision

**One app, two lines.** Beta is a release line of the normal ace app: same bundle id, same
install, same `~/.ace`. There is no separate dev app and no second data home. A person picks
the line in Settings › General › Updates: **Stable** or **Beta**. A stable build starts on
Stable, a beta build on Beta.

**macOS arm64 only.** `release:beta` refuses any other platform or architecture until the
owner says otherwise.

**Names.** A beta is a GitHub prerelease on `arpan404/ace`. It is never marked latest.

- Tag: `ace-beta-<YYYY-MM-DD>-<X.Y.Z>-<N>`, e.g. `ace-beta-2026-11-03-0.0.23-1`.
  - `<YYYY-MM-DD>`: the build date, in UTC.
  - `<X.Y.Z>`: `apps/desktop/package.json` at the built commit. That is the latest stable
    version, since stable releases bump it.
  - `<N>`: one more than the number of beta tags with the same date and version, starting at 1.
- Title: `ace beta 2026-11-03 (0.0.23, build 1)`.
- The version inside the app is semver: `X.Y.Z-beta.<YYYYMMDD>.<N>`
  (`0.0.23-beta.20261103.1`). `release:beta` sets it at build time and never edits
  `package.json`.

Semver ranks `0.0.23-beta.…` below `0.0.23`, so ace never uses semver to compare lines. The
release picker below orders them.

**Builds come from `origin/main`.** `release:beta` refuses a dirty checkout or a commit that
isn't on `origin/main`, and it signs and notarizes the same way `release:build` does. Squirrel.Mac
installs in place only when the update is signed with the running app's Developer ID. Migrations
on `main` are only appended, never reordered or reverted. A later stable release therefore
includes every migration a beta from an earlier commit ran.

**The app picks the release, not electron-updater.** electron-updater's GitHub provider skips
tags that aren't semver, so it can't see `ace-beta-…`. Instead a pure picker takes:

- the release list from GitHub's public releases API (no token);
- the installed version and line;
- the data formats the home holds.

It returns the release to offer, or none with a reason. The shell then points electron-updater
at that release with the generic provider:
`https://github.com/arpan404/ace/releases/download/<tag>/`. That folder holds the release's
`latest-mac.yml`, so electron-updater still checks the SHA-512 and Squirrel still checks the
signature. Neither trust root changes.

Releases are ordered by `(X.Y.Z, line, date, N)`, where a stable release ranks below a beta of
the same version. A beta of 0.0.23 is newer than stable 0.0.23 and older than stable 0.0.24.

- **Stable** offers the newest stable release.
- **Beta** offers the newest release of either line, so a beta install moves on to a stable
  release once that stable is the newest.
- Drafts never count. Prereleases whose tags aren't `ace-beta-…` never count.

Stable installs from before this ADR use `/releases/latest`, which excludes prereleases. Their
changelog skips tags that aren't semver. `ace update` (`tools/release/src/desktop-update.ts`)
reads only `v<semver>` tags. None of them ever sees a beta.

**Data formats travel with every release.** From now on, `release:build` and `release:beta` both
upload `ace-data.json`:

```json
{ "home": 1, "daemon": 63, "notify": 5, "spade": 9 }
```

The fields are `HOME_FORMAT_VERSION`, the daemon's `schemaVersion`, notify's `FORMAT` and
Spade's migration count, as built. The daemon reports what the home holds: the format marker and
each database's `user_version`.

**The guarded switch.** Moving to an older release, whether that's Beta → Stable or a downgrade
within a line, is offered only when every number in the target's `ace-data.json` is at least
the number in the home.

- When it is, the picker offers that release and the shell allows the downgrade for that
  install only.
- When it isn't, the switch is not offered, and Settings says why in one sentence: "Stable can't
  read this beta's data yet. You can switch once stable reaches a newer release."
- The block lifts on its own once a stable release ships with those migrations.
- A release without `ace-data.json` counts as unreadable. `v0.0.23` gets the file once, built
  from its own tag, so a beta of 0.0.23 that changed no data can go back to it.

The numbers live in the home, so they persist: a beta that migrated keeps blocking the way back
even after the person installs a later beta that migrates nothing. A change that an older build
can't read must therefore add a migration or bump `HOME_FORMAT_VERSION`, as `home-format.ts`
already requires. There is no manual "breaks downgrade" flag. It would be a second source of
truth that someone forgets to set.

Starting stable fresh on an empty home is never offered as a way around the block (ADR 0081
backups aside). It would leave stable without the person's data.

**The badge.**

- A beta build has a Dock icon with a "BETA" band, rendered by `scripts/icons.ts` at build time.
- The sidebar's foot shows the word **Beta**, as text beside the update button (no chip, no tint).
- The daemon's hello reports its line, so the web app connected to a beta daemon shows the same
  word. iOS follows later.

**Publishing.** `bun run release:beta build` stages the build under
`dist/releases/ace-beta-…`. `bun run release:beta publish` checks the staged hashes and that
the commit is on GitHub. It then uploads a draft prerelease and publishes it, so no app sees a
half-uploaded beta, as in `release:publish`. The owner's agents use the `publish-beta` skill.

## Consequences

- Betas reach only people who choose Beta. Stable installs see nothing new.
- A beta that migrates its databases keeps its testers on Beta until the next stable release.
  That's the intended cost.
- The picker reads GitHub's releases API unauthenticated (60 requests an hour per IP). That's
  enough at one check every four to six hours.
- Tests cover the picker's ordering and the guard's table, tag parsing and the next build
  number, and the published files. One process test runs the generic feed against a local HTTP
  server.
