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

## What install does (one admin authorization, `set -e`, additive, idempotent)

1. **Place the signed plug-in.** Remove only our previous copy, then
   `cp -R` the signed `AceLockedUseAuthorization.bundle` to
   `/Library/Security/SecurityAgentPlugins/AceLockedUseAuthorization.bundle`, `chown root:wheel`,
   `chmod 755`.
2. **Add ace as one more alternative of `system.login.screensaver`.**
   `security authorizationdb read system.login.screensaver` → a small `python3 plistlib` edit
   that appends `AceLockedUseAuthorization:permit` to the right's `mechanisms` **only if not
   already present** → `security authorizationdb write`. Apple's mechanisms and any other
   provider's are never removed or reordered.
3. **Load two root daemons.** Write `/Library/LaunchDaemons/dev.ace.locked-use.authorization.plist`
   (the authorization broker) and `/Library/LaunchDaemons/dev.ace.locked-use.guardian.plist`
   (the independent relock guardian), `chown root:wheel`, `chmod 644`, then
   `launchctl bootout` (ignored if absent) and `launchctl bootstrap system <plist>`.

If any step fails, `set -e` stops the script, so a half-finished install cannot report success;
the daemon re-detects and will not report **On** unless every component is proven valid.

## What removal does (reverse, tolerant of partial state)

1. `launchctl bootout system/<label>` and delete both LaunchDaemon plists.
2. Read the right and write it back with **only** our mechanism filtered out, leaving every
   other mechanism in place. A missing right is left alone (`|| exit 0`).
3. `rm -rf` our plug-in bundle.

Afterwards the detector must find no residue; if anything of ours remains, the feature reports
**Needs repair** rather than claiming it is off.

## Why this is safe to leave in the tree

- It only ever runs through `lockedUse.install`/`remove`/`repair`, which require daemon `admin`
  scope, and then through one macOS admin prompt. It is not wired to run on its own.
- Artifact paths are validated (absolute, no control characters) and shell-quoted, so a path can
  never break out into another command.
- The rule edit is additive and reversible; normal manual unlock and other authorization
  providers keep working.

## What still needs the person (and a real Mac)

1. Staging the signed native artifacts into the shipped app (plug-in bundle from
   `native/locked-use/build.sh`; the `ace-locked-use-authority` and `ace-locked-use-guardian`
   executables from the Swift package) and pointing the env vars at them.
2. Running the install once, with admin approval, on a Mac configured to lock on display sleep.
3. The single live locked test (self-created TextEdit/Calculator only) that is the only way to
   learn whether requesting `system.login.screensaver` actually dismisses the lock on this
   macOS. If it does not, the design stays locked and reports a clear error.
