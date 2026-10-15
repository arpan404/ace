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
  A home without that lock is an older ace's (0.x keeps no pid, port or socket file; its
  `~/.ace/daemon` is empty and its server and app hold `userdata/state.sqlite` open). ace then
  looks, two levels deep and skipping `worktrees`, for live `*.pid` files and for any process that
  still has the home's databases, journals, sockets or lock files open (`lsof -t`, bounded to
  five seconds). If one does, it refuses with `OldAceRunningError` ("Quit the old ace first") and
  moves nothing. A host without `lsof` falls back to the pid checks, so a fresh start never sticks.
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
- An install made with the release installer keeps working across a format bump. Its release is
  the program, not data: after the rename, `releases`, the `current` and `previous` pointers and
  `bin/ace` move back into the fresh home (renames in the same directory), but only when the
  launcher, pointer and release metadata are exactly what the installer writes for that home and
  no update is half applied. A 0.x launcher or the desktop shim stays in the backup.
- `ace service` accepts a home whose `bin/ace` is the desktop app's shim (it carries
  `CLI_SHIM_MARKER`): status, stop and uninstall work, and install says a release is needed. The
  desktop app keeps an installed release's launcher as the `ace` command instead of reporting it
  as foreign.
- The selection lock, `legacy-home.json`, `home-policy.ts` and the data-generation file are gone.
- The accounts registry's repair of older instance-home layouts (ADR 0041's amendment) is
  removed. A managed account under another data root is still refused, as `foreign_home`.

## Amendment: the desktop's own state after a fresh start

A fresh start gives the local daemon a new `host-id` and `daemon-token`, but the desktop app's
data folder (`<appData>/ace-next`: web storage, IndexedDB, `notification-outboxes`) is not
part of the home and is not renamed. Clients pin each outbox to the daemon identity they first
met (ADR 0030, ADR 0066), so the window refused its own new daemon as "another daemon".

- For the daemon it runs on this computer, the desktop reads `host-id` with the token from the
  current home and hands it to the page and to its own link as `localHostId`. Both expect
  exactly that identity, and key that daemon's outbox by it instead of by address. A fresh
  start (or a different `ACE_HOME`) therefore starts an empty outbox with no manual step; work
  saved for the old daemon stays under the old identity and is never sent to the new one.
- A daemon reached by address (a remote one, or one entered by hand) keeps the strict check: a
  different identity at a known address is refused as `identity`, not as a rejected token. The
  connection screen says it is a different ace and offers "Forget the old ace", which drops the
  old binding and the work saved for it, then connects.
- The data folder keeps its name. `<appData>/ace` belongs to the 0.x app (see `user-data.ts`),
  and keying local state to the home's identity makes a versioned folder unnecessary.
