# Locked-use production packaging

Scope: signed macOS desktop packages. This records build/runtime wiring, not proof that
Authorization Services unlocks a logged-in Mac.

## Implemented

- The screen helper builds through SwiftPM, linking `LockedUseService` into `--locked-use`.
  Its cache includes the locked-use sources and both package manifests.
- Signed releases build the authorization bundle, authority broker and relock guardian with
  the helper's selected Developer ID identity. Each executable has its expected identifier;
  release signatures use secure timestamps and are preserved during app signing.
- Resources/locked-use contains those components and a schema-checked team manifest.
  Signed packaging rejects missing components, including when skipping the build.
- Packaged daemon startup supplies the component paths and team from those resources,
  clearing inherited locked-use overrides. Unsigned packages omit these resources.
- The launchd plists reserve `dev.ace.locked-use.authorization`, `dev.ace.locked-use.broker`
  and `dev.ace.locked-use.guardian` for the corresponding NSXPC listeners.
- Installation remains an explicit Settings action using macOS administrator authorization.
  Building and these verification commands do not install anything or edit authorizationdb.

## Executed on 2026-10-29

- `swift build --package-path native/screen-helper -c release --product ace-screen-helper --jobs 4`: passed.
- Built `ace-locked-use-authority` and `ace-locked-use-guardian` in release configuration: passed.
- The built helper's `--locked-use --socket /tmp/ace-locked-link-proof.sock` with closed stdin
  exits 2 with `no daemon token on stdin`, proving the real service handshake is linked.
- `swift test --package-path native/locked-use --jobs 4`: 131 tests passed.
- `sh native/locked-use/test-abi.sh`: both fail-closed and verified-boundary harnesses passed.
- Focused desktop packaging/startup and privileged-installer tests: 19 tests passed.
- Repository TypeScript checking and lint passed. The full repository check remains subject
  to the unrelated baseline failures recorded in PR #1523.

## Remaining release gate

The local keychain has no Developer ID Application identity. The release-signing preflight
fails explicitly with `release signing needs a "Developer ID Application" identity`.
No production-signed package was produced, installed or notarized in this verification run.
No live lock, unlock, crash/relock, display-change or sleep/wake test was performed.

After the release identity and notarization credentials are available, build the signed
package with `bun run desktop:package`, review the privileged installation script, and have
the owner approve installation from Settings. Confirm detection reports On. Then perform
and record the real-Mac tests required by ADR 0087, including guardian recovery after process
failure and preservation of ordinary manual unlock. Keep every existing authorization-rule
alternative. A successful build, authorization result or On label alone is not proof that the
session actually unlocks and reliably relocks.
