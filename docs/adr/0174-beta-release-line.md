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
Stable, a beta build on Beta. The first build that runs saves its line as the person's choice,
so a beta install stays on Beta after it updates to a stable release.

**macOS arm64 only.** `release:beta` refuses any other platform or architecture until the
owner says otherwise.

**Names.** A beta is a GitHub prerelease on `arpan404/ace`. It is never marked latest.

- Tag: `ace-beta-<YYYY-MM-DD>-<X.Y.Z>-<N>`, e.g. `ace-beta-2026-11-16-0.0.24-1`.
  - `<YYYY-MM-DD>`: the build date, in UTC.
  - `<X.Y.Z>`: the next version, the one the beta previews. By default it is the patch after
    `apps/desktop/package.json` at the built commit (the latest stable, since stable releases
    bump it): a beta built at 0.0.23 is a beta of 0.0.24. `release:beta build --version 0.1.0`
    names a later one instead; it must be greater than `package.json`'s version.
  - `<N>`: one more than the number of beta tags with the same date and version, starting at 1.
- Title: `ace beta 2026-11-16 (0.0.24, build 1)`.
- The version inside the app is semver: `X.Y.Z-beta.<YYYYMMDD>.<N>`
  (`0.0.24-beta.20261116.1`). `release:beta` sets it at build time and never edits
  `package.json`.

Because a beta carries the next version, semver orders every release: 0.0.23 <
0.0.24-beta.20261116.1 < 0.0.24-beta.20261116.2 < 0.0.24. The date and build number sit in the
prerelease part and compare numerically.

**Builds come from `origin/main`.** `release:beta` refuses a dirty checkout, untracked files git
doesn't ignore (a build copies some folders whole, so they would ship), or a commit that isn't
on `origin/main`, and it signs and notarizes the same way `release:build` does. Squirrel.Mac
installs in place only when the update is signed with the running app's Developer ID. Migrations
on `main` are only appended, never reordered or reverted. A later stable release therefore
includes every migration a beta from an earlier commit ran.

**The app picks the release, not electron-updater.** electron-updater's GitHub provider skips
tags that aren't semver, so it can't see `ace-beta-…`. Instead a pure picker takes:

- the release list from GitHub's public releases API (no token), read page by page until it
  reaches a stable release (at most five pages of a hundred), with `/releases/latest` added
  when those pages hold none;
- the installed version and line;
- the data formats the home holds.

It returns the release to offer, or none with a reason. The shell then points electron-updater
at that release with the generic provider:
`https://github.com/arpan404/ace/releases/download/<tag>/`. That folder holds the release's
`latest-mac.yml`, so electron-updater still checks the SHA-512 and Squirrel still checks the
signature. Neither trust root changes.

Releases are ordered by semver. A beta of 0.0.24 is newer than stable 0.0.23 and older than
stable 0.0.24, and of two betas of 0.0.24 the later date, then the higher build number, is newer.

- **Stable** offers the newest stable release.
- **Beta** offers the newest release of either line, so a beta install moves on to its
  version's stable release once that ships.
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
Spade's migration count, as built. Spade's number comes from the server binary the release
ships (`spade --schema-version`); the build stops if it differs from what `spade/` at the commit
migrates to, which catches a stale prebuilt `ACE_SPADE_SERVER_BIN`. The daemon reports what the home holds: the format marker,
the event database's version from its `schema_version` table (the daemon keeps its schema
there, not in `PRAGMA user_version`), and the notification and Spade databases' `user_version`.
It reads each database read-only, so a committed migration still in the WAL counts. A file the
home lacks reads as null and never blocks; a file that is there but can't be read (locked,
damaged, timed out) is named as unreadable, and blocks any switch to an older release.

**The guarded switch.** Moving to an older release, whether that's Beta → Stable (0.0.24-beta.…
→ 0.0.23) or a downgrade within a line, is offered only when every number in the target's `ace-data.json` is at least
the number in the home.

- When it is, the picker offers that release and the shell allows the downgrade for that
  install only. electron-updater's `allowDowngrade` is on for that switch and nothing else.
- The guard runs again, on what the daemon reads in the home then, right before the download
  and right before any install: Restart, `ace update apply`, and an install asked from another
  client. A release it now refuses is dropped, and Settings says why. Spade starting for the
  first time after the check is the case this catches.
- A switch to an older release never installs on quit, and on macOS it reaches Squirrel only
  when the person's Restart installs it, after that last guard.
- When it isn't, the switch is not offered, and Settings says why in one sentence: "Stable can't
  read this beta's data yet. You can switch once stable reaches a newer release."
- The block lifts on its own once a stable release ships with those migrations.
- A release without `ace-data.json` counts as unreadable. `v0.0.23` gets the file once, built
  from its own tag, so a beta of 0.0.24 that changed no data can go back to it.

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
