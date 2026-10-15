# 0081: Versioned data home

Date: 2026-10-15. Status: accepted by owner decision. Replaces the legacy isolation section of
ADR 0041 and its "rewrite home is always separate" amendment, and merges ADR 0080's data
generation into the home's format marker.

## Context

Interim builds kept their data in `~/.ace-next`. The daemon chose that home whenever `~/.ace`
held data from an earlier ace, and wrote `legacy-home.json` there to record that the old home was
left for a later migration decision. That left two homes, a selection lock, a marker that only
explained itself, and the `ace` command shim in `~/.ace/bin` pointing into a different home than
the daemon's. ADR 0080 then added a second version mechanism, the `data-generation` file, to stop
an older build from opening newer data.

The owner's decision: ace's data home is `~/.ace` again, it records its format, and the first
start of an updated app is a fresh start. Nothing is migrated.

## Decision

**One home, one format marker, and a rename for anything older.**

- The default home is `~/.ace`. `ACE_HOME` still selects another and gets the same versioning.
  `resolveDaemonHome` in `@ace/service/home` only names the path.
- `HOME_FORMAT_VERSION` in `packages/service/src/home-format.ts` is the one constant. The home's
  `ace-format.json` holds `{"format":"ace-vN","createdAt":"<ISO time>"}`, written whole (a
  temporary file linked into place) with mode 0600. The current format is `ace-v1`. It takes the
  place of ADR 0080's `DATA_GENERATION` and `data-generation` file: any change to a persisted
  format that the previous build cannot read bumps it in the same change.
- `prepareDaemonHome` runs before anything opens or writes in the home: before the daemon's lock
  and stores, and before the desktop app writes the `ace` shim.
  - Missing: create it (0700) and write the marker. An empty directory (a new `ACE_HOME`) gets
    the marker.
  - Current format: used as it is.
  - No readable marker (an earlier ace, or anything else), or an older format: rename the home in
    one `rename(2)` to `<home>-v<old>` beside it (`~/.ace-v0` for unversioned data,
    `~/.ace-v1` after the bump to v2). If that name is taken, `.1`, `.2` and so on; a backup is
    never overwritten. Then create a fresh home and write the marker.
  - Newer format: refuse with the clear message ADR 0080 introduced (`NewerDataError`) and exit 65.
    Nothing is renamed.
- While renaming, ace holds the old home's daemon lock exactly as a daemon would take it (an
  exclusive transaction on `daemon-lock.sqlite`). If a running daemon holds it, ace refuses with
  `LiveHomeError` and moves nothing. A home without that database falls back to the pid in
  `daemon-lock`. Kernel locks end with their process, so a crashed daemon never blocks a fresh
  start. After taking its own lock, the daemon prepares again, so a newer build that set the home
  aside in between is caught.
- The backup sits in the home's own parent directory, so the rename never crosses filesystems. A
  home that is a symbolic link is renamed as the link; what it points at stays where it is. If
  the rename still reports `EXDEV`, ace refuses and names the path. It never copies and deletes.
- The rename is the only blocking step. After startup, off the startup path, ace leaves a short
  `BACKUP-README.txt` in the backup, measures it, and logs the backup's path, previous format and
  size: the daemon in `logs/ace.jsonl` when it made the fresh start, the desktop app in its own
  log when it did. Backups are never deleted automatically.
- Every writer prepares first: the daemon (`ace start`), the desktop app for its managed daemon
  (before the shim, which now goes in `<home>/bin/ace`), `ace accounts`, `ace config`,
  `ace remote`, `ace cloud`, `ace pair redeem`, `ace service` and the release installer. The
  service commands still refuse an installed launcher that is not a validated release.
- `~/.ace-next` is ignored. ace does not read, move or migrate it. Delete it once it is no longer
  needed.

## Consequences

- Opening the updated app is a fresh start for every person: threads, settings, accounts and
  worktrees from interim builds stay in `~/.ace-next` (and anything older in `~/.ace-v0`) and do
  not appear. This was chosen over a migration while ace is pre-release.
- A future format bump is the same fresh start with no new code: raise `HOME_FORMAT_VERSION`.
- An install made with the release installer keeps its release inside the home, so a format bump
  sets that installation aside too; reinstall afterwards. The desktop app, which ships its own
  runtime, is unaffected.
- The selection lock, `legacy-home.json`, `home-policy.ts` and the data-generation file are gone.
- The accounts registry still repairs older instance-home layouts on startup (ADR 0041's
  amendment). A fresh home has no such accounts, so it no longer runs in practice; removing it
  is a follow-up.
