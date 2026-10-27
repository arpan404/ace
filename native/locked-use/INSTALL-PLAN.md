# Locked Use — the privileged install, for review before it runs

Turning on "Let agents work while this Mac is locked" runs one privileged step that changes
this Mac's authorization policy. Per ace's rule it needs the person's explicit yes and a macOS
administrator authorization. This file is the exact plan, so it can be reviewed **before**
anything runs on a real Mac. The code that assembles these commands is
`apps/daemon/src/locked-use-privileged.ts` (pure, unit-tested); the detector that verifies the
result is `packages/screen/src/locked-use-detect.ts` (read-only).

Nothing here stores or asks for the login password — macOS collects it at the admin prompt.
The real runner is inert unless the signed artifacts are staged in the environment
(`ACE_LOCKED_USE_PLUGIN`, `ACE_LOCKED_USE_BROKER`, `ACE_LOCKED_USE_GUARDIAN`); on a dev Mac they
are absent, so install stays unavailable and the feature reports **Needs approval**.

All temp files live in a fresh root-owned `mktemp -d` directory with `umask 077`, never fixed
`/tmp` paths a same-user process could pre-create or symlink. Each copied component is
signature-checked against ace's pinned team before it is trusted or run.

## What install does (one admin authorization, `set -e`, additive, idempotent)

1. **Stage and verify every component to a root-owned path.** `cp -R` the signed plug-in to
   `/Library/Security/SecurityAgentPlugins/AceLockedUseAuthorization.bundle`, and the broker and
   guardian executables to `/Library/Application Support/dev.ace.locked-use/` (never a
   user-writable app directory). `chown -R root:wheel`, `chmod -R 755`, then
   `codesign --verify --strict -R '=anchor apple generic and certificate leaf[subject.OU] =
"<TEAM>" and identifier "<id>"'` on each copy. A failed check aborts the script.
2. **Add ace as one NAMED alternative of `system.login.screensaver`.** First
   `security authorizationdb write dev.ace.locked-use.permit` a dedicated
   `evaluate-mechanisms` right whose only mechanism is `AceLockedUseAuthorization:permit`. Then
   read `system.login.screensaver`; a `python3 plistlib` edit **refuses unless that right is
   `class rule` with `k-of-n` 1** (an OR), and appends the name `dev.ace.locked-use.permit` to
   its `rule` list only if absent; write it back. The screensaver right's own `mechanisms` key is
   never written, and Apple's alternatives are never removed or reordered. Because the rule is an
   OR, adding an alternative can never block ordinary password unlock.
3. **Load two root daemons from the verified copies.** Write
   `/Library/LaunchDaemons/dev.ace.locked-use.authorization.plist` (broker) and
   `…guardian.plist`, `chown root:wheel`, `chmod 644`, then `launchctl bootout` (ignored if
   absent) and `launchctl bootstrap system <plist>`.

If any step fails, `set -e` stops the script, so a half-finished install cannot report success;
the daemon re-detects and will not report **On** unless every component is proven valid.

## What removal does (reverse, tolerant of partial state)

1. `launchctl bootout system/<label>` and delete both LaunchDaemon plists.
2. Read the screensaver right and write it back with **only** our name removed from its `rule`
   list, leaving every other alternative in place. A missing right is left alone (`|| exit 0`).
3. `security authorizationdb remove dev.ace.locked-use.permit`.
4. `rm -rf` the plug-in bundle and both root-owned executables.

Afterwards the detector must find no residue; if anything of ours remains, the feature reports
**Needs repair** rather than claiming it is off.

## Why this is safe to leave in the tree

- It only ever runs through `lockedUse.install`/`remove`/`repair`, which require daemon `admin`
  scope, and then through one macOS admin prompt. It is not wired to run on its own.
- Artifact paths are validated (absolute, no control characters) and shell-quoted, so a path can
  never break out into another command.
- The rule edit is additive and reversible; normal manual unlock and other authorization
  providers keep working.

Each component is copied to a `.staging` path beside its destination, signature-checked there,
and only then `mv`-ed into place, so a failed check never leaves an unverified file where a root
daemon or the rule would load it. A symlinked source or staged copy is refused.

## Known follow-up (gated on the real-Mac verification)

- The rule edit currently shells out to `/usr/bin/python3`, which is only a stub on a Mac without
  the Command Line Tools. Before shipping, move the plist edit to a compiled helper (e.g. a
  subcommand of the already signature-checked broker) so install has no Python dependency.
- A same-user process could launch its own copy of the signed service. The broker now binds one
  coordinator, refuses takeovers while an attempt may be live, and requires the service's parent
  to be ace-signed; what remains is described under "Coordinator trust" in `README.md`.

## What still needs the person (and a real Mac)

1. Staging the signed native artifacts into the shipped app (plug-in bundle from
   `native/locked-use/build.sh`; the `ace-locked-use-authority` and `ace-locked-use-guardian`
   executables from the Swift package) and pointing the env vars at them.
2. Running the install once, with admin approval, on a Mac configured to lock on display sleep.
3. The single live locked test (self-created TextEdit/Calculator only) that is the only way to
   learn whether requesting `system.login.screensaver` actually dismisses the lock on this
   macOS. If it does not, the design stays locked and reports a clear error.
