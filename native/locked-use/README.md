# Locked Use components

This package contains an uninstalled authorization component, reusable native policy/UI
libraries, and the production service, guardian and broker pieces that will host them.
**It does not enable locked computer use in ace.** The screen helper's `--locked-use` mode
hosts the service, but no launch daemon or authorization rule is registered, the daemon does
not talk to it yet, and the current computer-use engine retains its locked-input refusals.

The clean-room design is based on [the interface investigation](../../docs/research/macos-codex-locked-use.md)
and [Apple's authorization API boundaries](../../docs/research/macos-authorization-plugin-locked-use.md).

## Implemented

| Component                                          | Behavior                                                                                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LockedUseCore`                                    | Scoped, single-use permits; exact display topology; fresh protection at authorization; expiry; cancellation; takeover latch; confirmed-lock teardown; late-callback rejection     |
| `LockedUseIPC`                                     | Authorization-only XPC endpoint with Apple engine-host signing requirements, bounded input/deadline validation and replay rejection                                               |
| Authorization bundle                               | Real `AuthorizationPluginCreate` ABI, mechanism lifecycle, immutable attempt binding, broker signature pinning, bounded asynchronous decisions and cancellation cleanup           |
| `LockedUseUI`                                      | Opaque monochrome covers, physical/mirrored display mapping, topology-loss notification, input suppression and conservative takeover classification                               |
| `LockedUseRuntime`                                 | Serialized coordinator connecting the authorization endpoint, native covers/input, approved work, cancellation, OS session observations and independent guardian boundary         |
| `LockedUseSystem`                                  | OS adapters: Quartz session facts, the `system.login.screensaver` unlock candidate request, display-sleep relock, team-pinned peer requirements and read-only installation probes |
| `LockedUseSession`                                 | Production `LockedUseSessionDriver`, session observer and the unlock binding that ties the plug-in's engine transaction to this driver's pending request                          |
| `LockedUseGuardianKit` / `ace-locked-use-guardian` | Watchdog that relocks on heartbeat loss, link drop or owner exit, its XPC server, and the launch-daemon executable                                                                |
| `LockedUseBrokerKit` / `ace-locked-use-authority`  | Root broker owning `dev.ace.locked-use.authorization`; forwards plug-in queries to the registered GUI coordinator                                                                 |
| `LockedUseTransport`                               | Daemon socket transport: length-prefixed JSON frames, lenient request decoding, documented replies and events                                                                     |
| `LockedUseService`                                 | GUI-session service: coordinator, native desktop, driver, guardian/broker clients, cover-ordering verifier; hosted by `ace-screen-helper --locked-use --socket <path>`            |
| Build/test scripts                                 | Signed local bundle and a fake-engine ABI harness; neither script installs anything or changes OS policy                                                                          |

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
parameters. `LockedUseService` supplies production versions of these (see below). Requesting
the authorization right is still never treated as if it unlocked loginwindow.

The coordinator arms the guardian, prepares protection, requests the bound OS unlock,
consumes the authorization permit, and waits for an actual unlocked-session observation
before starting work. Every grant rechecks protection and transaction binding. Completion,
cancellation, takeover, protection loss and session loss stop work and request relock.
An unavailable session confirms neither unlock nor lock. Covers are removed only after
the matching OS lock observation. Completion and guardian disarm additionally wait for the
work task to exit. Until then another attempt is refused and status remains relocking.
The host's work closure must propagate cancellation to its helper processes and await their
termination; cancelling a Swift task alone does not prove a child process stopped.

Runtime, session, guardian, broker and service tests use substitute OS and guardian boundaries, without changing this Mac's lock,
opening covers or installing an event tap. They prove coordinator behavior, not actual OS
unlocking or crash relock. A counterfactual run removing the confirmed-lock completion gate
fails the named completion test.

## Production pieces

Process layout once installed (nothing here installs it):

| Process                          | Runs as         | Owns                                                                                 |
| -------------------------------- | --------------- | ------------------------------------------------------------------------------------ |
| `ace-screen-helper --locked-use` | the person, GUI | Coordinator, covers, input guard, session driver, daemon socket                      |
| `ace-locked-use-authority`       | root daemon     | `dev.ace.locked-use.authorization` (plug-in queries) and `dev.ace.locked-use.broker` |
| `ace-locked-use-guardian`        | root daemon     | `dev.ace.locked-use.guardian`                                                        |

**Unlock.** `requestUnlock` asks Authorization Services for `system.login.screensaver`
without interaction, passing the attempt id as the `dev.ace.locked-use.attempt` environment
item. That is the best-supported candidate; whether loginwindow turns it into an actual
unlock is **unverified**. Its result is never treated as an unlock: only a fresh Quartz
session read for the scope's user and audit session (`kCGSSessionAuditIDKey`) can report
`unlocked`, and the coordinator re-reads it itself. A refused request is reported as an
`unlock_request_failed` event and the attempt expires into relock.

**Binding.** `binds(request, to:)` accepts the plug-in's opaque engine transaction only for
the scope's attempt id, while this driver's own unlock request is pending (one second),
while the approved session is still locked, and only for the first transaction that claims
it. The transaction cannot be proven to belong to this process's AuthorizationRef, so the
daemon must use an unguessable, single-use attempt id.

**Relock.** `pmset displaysleepnow`, which locks only when the screen lock delay is
immediate; the installation probe requires that setting. It needs no event tap and the
guardian issues the same request from its own process. Covers come down only after a
session read confirms the lock.

**Guardian.** Armed over XPC with the JSON scope. The owner's pid and user come from the
kernel-attested connection; the scope's user must match. It relocks when no heartbeat
arrives for one second, when the link drops, or when the owner process exits, then repeats
the request three times two seconds apart and stops so it cannot fight a manual unlock.
Disarm is accepted only from the arming owner, after its confirmed lock. Its state is in
memory: a guardian restart drops the link, and the service then stops work.

**Covers.** The service's ordering verifier requires that on every display the frontmost
visible window, other than loginwindow's (by bundle id), is our cover spanning that
display. Any other overlay fails closed. This is unverified on real lock-screen hardware.

**Installation facts.** `verifiedInstallation` is true only when the plug-in at
`/Library/Security/SecurityAgentPlugins/AceLockedUseAuthorization.bundle` satisfies our
team requirement, `system.login.screensaver` reaches `AceLockedUseAuthorization:permit`,
the screen lock delay is immediate, the broker accepted registration and the guardian
answered. Probes are read-only and refreshed every five seconds. An unsigned build has no
team and can never verify.

### Daemon transport

A Unix socket (mode 0600, same user only, one daemon at a time). Each frame is a 4-byte
big-endian length followed by 1–65,536 bytes of UTF-8 JSON. A bad length closes the
connection, and a closed connection stops any attempt (`connectionLost`). Unknown fields are
ignored; unknown types or versions get an `unsupported` reply. `v` may be omitted.

Requests (`id`: 1–64 characters, echoed in the reply):

```json
{"v":1,"id":"r1","type":"status"}
{"v":1,"id":"r2","type":"enable"}
{"v":1,"id":"r3","type":"disable"}
{"v":1,"id":"r4","type":"begin","agentProcessIDs":[4242],
 "scope":{"userID":501,"sessionID":100003,"threadID":"…","turnID":"…","attemptID":"…"}}
{"v":1,"id":"r5","type":"finish","attemptID":"…"}
{"v":1,"id":"r6","type":"cancel","attemptID":"…"}
```

Messages from the service:

```json
{"v":1,"type":"reply","id":"r1","ok":true,"status":{…}}
{"v":1,"type":"reply","id":"r4","ok":false,"error":{"code":"not_locked","message":"…"}}
{"v":1,"type":"state","status":{…}}
{"v":1,"type":"completion","attemptID":"…","threadID":"…","turnID":"…","reason":"finished","workError":null}
{"v":1,"type":"error","code":"unlock_request_failed","message":"…","attemptID":"…"}
```

`status` is `{"phase","session","userID","sessionID","attemptID","installation":{"pluginSigned",
"ruleReachesMechanism","lockOnDisplaySleep","brokerLinked","guardianLinked","verified"}}`. `phase`
is one of `disabled`, `ready`, `covering`, `authorizing`, `unlocking`, `working`, `relocking`,
`manualUnlockRequired`, `faulted`; `session` is `locked`, `unlocked` or `unavailable`. Take the
scope's `userID` and `sessionID` from `status`. Run computer-use tools only while `phase` is
`working`, then send `finish`. `completion` arrives only after the work exited and the OS
confirmed the lock; `reason` is a `LockedUseStopReason`. Reply error codes: `not_installed`,
`not_enabled`, `not_locked`, `busy`, `manual_unlock_required`, `stale_attempt`,
`unknown_attempt`, `unsupported`, `malformed`, `failed`. A malformed frame without a readable
id produces an `error` event with code `malformed`. Event codes also include
`relock_request_failed`.

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

1. Verify on an isolated Mac that the `system.login.screensaver` request actually drives
   loginwindow to unlock through the plug-in, that the environment item reaches it as the
   immutable hint, and that display-sleep relock is observed as locked. The driver is
   implemented; these OS behaviors are not established.
2. Confirm the guardian relocks on a real Mac when the helper, covers or agent process die,
   and test display changes and sleep/wake. Crash independence is tested only with
   substitute lock sinks and an in-process XPC link.
3. Connect the TypeScript daemon to the transport above, with turn approval and
   cancellation. Agent tool arguments must never assert protection readiness, authorization
   identity or manual unlock. Add the module to `screen-helper/build.sh` so release builds
   include `--locked-use`.
4. Add explicit user opt-in and an authorized installation/removal transaction that preserves
   normal manual authentication and other installed authorization providers.
5. Package, sign, notarize and validate all components on isolated macOS fixtures, then obtain
   approval before changing this Mac's security policy.

There is deliberately no user-facing enable switch, privileged installer, default allow
path, daemon-facing unlock command, or automatic change to `system.login.screensaver` in this
package. The unlock candidate request is reachable only from the coordinator, after covers,
input guard and guardian are ready for an approved, locked session.
