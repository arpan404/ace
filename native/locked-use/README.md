# Locked Use components

This package contains an uninstalled authorization component and reusable native policy/UI
libraries. **It does not enable locked computer use in ace.** No application imports it yet,
no launch daemon or authorization rule is registered, and the current computer-use engine
retains its locked-input refusals.

The clean-room design is based on [the interface investigation](../../docs/research/macos-codex-locked-use.md)
and [Apple's authorization API boundaries](../../docs/research/macos-authorization-plugin-locked-use.md).

## Implemented

| Component            | Behavior                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LockedUseCore`      | Scoped, single-use permits; exact display topology; fresh protection at authorization; expiry; cancellation; takeover latch; confirmed-lock teardown; late-callback rejection |
| `LockedUseIPC`       | Authorization-only XPC endpoint with Apple engine-host signing requirements, bounded input/deadline validation and replay rejection                                           |
| Authorization bundle | Real `AuthorizationPluginCreate` ABI, mechanism lifecycle, immutable attempt binding, broker signature pinning, bounded asynchronous decisions and cancellation cleanup       |
| `LockedUseUI`        | Opaque monochrome covers, physical/mirrored display mapping, topology-loss notification, input suppression and conservative takeover classification                           |
| `LockedUseRuntime`   | Serialized coordinator connecting the authorization endpoint, native covers/input, approved work, cancellation, OS session observations and independent guardian boundary     |
| Build/test scripts   | Signed local bundle and a fake-engine ABI harness; neither script installs anything or changes OS policy                                                                      |

Policy functions take continuous monotonic time and trusted I/O facts explicitly. The owning broker must
serialize authority access. Effects are commands to that owner; returning `relock` does not
mean the OS has locked. Covers remain until a matching session/attempt lock confirmation.
A failed relock remains faulted, and stale callbacks cannot mark a new turn ready. A stopped
or disabled setting does not clear a local-takeover latch.

The pure authority bounds work to sixty seconds per protected interval. The authorization
window is one second and protection must have a heartbeat less than 500 ms old. An attempt
id is never reusable within an authority instance; its ledger fails closed at 4096 attempts
and requires an owner restart. These limits are explicit prototype behavior, not a substitute
for wiring turn completion and an independent watchdog into the real daemon.

## Runtime integration

`LockedUseCoordinator` is the native lifecycle owner. `LockedUseAuthorizationBridge`
connects its decisions to the signature-checked XPC endpoint. `LockedUseNativeDesktop`
connects the actual AppKit panels and HID input guard; construction activates neither.
The runtime requires an independent window-ordering verifier before those panels can
contribute to protection readiness. There is no default verifier that returns true.

The trusted host supplies a verified `LockedUseSessionDriver`, a separately supervised
`LockedUseGuardian`, a continuous clock and a recurring heartbeat scheduler. It must provide
the approved daemon thread/turn scope to `begin`; these are not agent-controlled tool
parameters. No production OS driver or guardian is supplied yet. In particular, requesting
an authorization right is not implemented as if it unlocked loginwindow.

The coordinator arms the guardian, prepares protection, requests the bound OS unlock,
consumes the authorization permit, and waits for an actual unlocked-session observation
before starting work. Every grant rechecks protection and transaction binding. Completion,
cancellation, takeover, protection loss and session loss stop work and request relock.
An unavailable session confirms neither unlock nor lock. Covers are removed only after
the matching OS lock observation. Completion and guardian disarm additionally wait for the
work task to exit. Until then another attempt is refused and status remains relocking.
The host's work closure must propagate cancellation to its helper processes and await their
termination; cancelling a Swift task alone does not prove a child process stopped.

Runtime tests use substitute OS and guardian boundaries, without changing this Mac's lock,
opening covers or installing an event tap. They prove coordinator behavior, not actual OS
unlocking or crash relock. A counterfactual run removing the confirmed-lock completion gate
fails the named completion test.

## Authorization boundary

The plug-in exports `AceLockedUseAuthorization:permit`. It requires an immutable
`dev.ace.locked-use.attempt` hint and a live authorization transaction. It queries the root
Mach service `dev.ace.locked-use.authorization`, requiring an authority executable signed
with ace's pinned team and the identifier `dev.ace.locked-use.authority`. Missing binding,
unavailable/wrongly signed authority, timeout, deactivation and destruction never authorize.
The endpoint exports no enable, arm, install or general unlock operation.

The XPC verifier is supplied by the eventual trusted authority owner. It **must** bind the
opaque engine transaction to the exact approved GUI user/session and turn before consuming
an authority permit. A callback that merely returns true would defeat this boundary; no such
production callback is provided. `AuthorizationSessionId` identifies a top-level
authorization transaction and is not `SecuritySessionId` or an audit-session identifier.
The plug-in does not reinterpret its pointer bytes as a logged-in user's session number.

The client and server share a 750 ms continuous monotonic deadline using
`CLOCK_MONOTONIC_RAW`, which includes sleep, as described in Apple’s
[continuous-clock documentation](https://developer.apple.com/documentation/kernel/1646199-mach_continuous_time). The client checks the deadline again when
a reply arrives, even if its dispatch timer was delayed by system sleep. The client enforces its own timer
and reports at most one decision even if connection error, timeout and reply race. The
server rejects stale or excessively future deadlines. Identifiers, a signing requirement
and an immutable hint alone do not prove a safe screen-unlock protocol.

## Display and input boundary

`LockedUseDisplayCover.prepare` creates native panels on all available rendered surfaces.
Its acknowledgement describes those panels, not a proof of secure window ordering across
Spaces. A separate owner must verify that ordering, input suppression, independent relock
readiness and the OS transaction before arming anything. Attaching/removing a display
invalidates the acknowledgement; old covers remain while the owner requests relock.

`LockedUseInputGuard` uses a suppressing HID tap only when explicitly started with existing
OS permission. It never prompts for permission during construction or the preview. Physical
and unknown input sources cause takeover; tap failure loses readiness instead of silently
resuming. Agent process ids come from the trusted owner. Event source metadata is used only
for takeover classification, never to authenticate a client or grant authorization. A relock
driver must not depend on synthesizing input through a tap that is suppressing takeover.
The owner must stop the tap after confirmed OS lock so normal manual authentication works.

There is no claim that these panels alone provide a secure lock screen, or that an in-process
event tap can enforce relock after its process dies.

## Build and verification

```sh
swift test --package-path native/locked-use
sh native/locked-use/test-abi.sh
sh native/locked-use/build.sh
sh native/locked-use/test-plugin.sh
```

The build script reuses the screen helper's persisted Developer ID identity and validates the
bundle's actual signing team against its compiled pin. Explicit overrides are
`ACE_SCREEN_SIGN_IDENTITY` and `ACE_LOCKED_USE_TEAM`. Ad-hoc signing is refused. The local
bundle is hardened but has no secure timestamp or notarization ticket; it is not a release
installer. Outputs stay under ignored `build/`.

The macOS CI job runs the Swift suite and `test-abi.sh`, which compiles an unsigned
fixture with a non-production signing pin and exercises the same ABI without credentials.
That fixture is not a distributable component.

The local `test-plugin.sh` ABI harness loads the real signed bundle into a fake engine to test denied requests,
deadlines, duplicate callbacks and destruction. A separate fixture supplies a verified reply
to exercise grant/deactivation behavior at the I/O boundary. The fixture is never linked
into the production bundle. These checks do not authenticate a real SecurityAgent peer or
exercise real OS unlocking.

To render the native status view offscreen without opening covers or installing an input tap:

```sh
swift run --package-path native/locked-use LockedUsePreview /tmp/ace-locked-use-cover.png
```

## Required before integration or installation

1. Implement and verify a supported driver that initiates the actual OS unlock transaction
   and binds its immutable hint, authorization transaction and target GUI session.
2. Implement an independent relock guardian and confirm it still works if the desktop, cover
   host, authority connection or agent process dies. Test display and sleep/wake transitions.
3. Host the runtime coordinator in the trusted native service and connect desktop/daemon
   turn approval and cancellation. Agent tool arguments must never assert protection
   readiness, authorization identity or manual unlock. The coordinator and native/XPC adapters
   are implemented; the service, daemon transport and production OS/guardian drivers are not.
4. Add explicit user opt-in and an authorized installation/removal transaction that preserves
   normal manual authentication and other installed authorization providers.
5. Package, sign, notarize and validate all components on isolated macOS fixtures, then obtain
   approval before changing this Mac's security policy.

There is deliberately no user-facing enable switch, privileged installer, default allow
path, OS-unlock command, or automatic change to `system.login.screensaver` in this package.
