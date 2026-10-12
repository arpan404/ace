# 0073: Native mobile clients share the headless SDK and design tokens

Date: 2026-10-11. Status: accepted stack and Phase 0 evidence; performance gate held.

## Context

Issues #560 and #561 define one mobile product with a native SwiftUI iOS app and
an Android app using Expo and Jetpack Compose. The approved mobile v2 mockup has
one inbox, pushed threads, sheets and a floating composer. There is no tab bar.
OEM typography and wallpaper-derived Material colours cannot define ace's theme.
Both apps must preserve the daemon's whole-tree status across disconnects.

## Decision

Android uses the current stable Expo SDK 57, its New Architecture and Hermes.
Expo UI's Compose APIs are stable as of SDK 56. SwiftUI on iOS hosts the same
`@ace/client` in JavaScriptCore. Neither app implements reconnect, replay,
command idempotency, durable outbox or status folding independently.

`@ace/design-tokens` owns versioned JSON and a Zod-validated TypeScript view.
Android consumes the validated view and serializes it for its Compose theme.
iOS generates Swift from the same JSON and validates it before generation.
Status marker colours match web presets; the distinct `statusText` palette
passes normal-text contrast on every permitted content surface.

Android has an ace Material 3 theme. Dynamic colour is off. A small local Expo
module wraps Compose children with exact token colours, typography, shapes and
ripple. Inter and JetBrains Mono are bundled under their SIL Open Font Licenses.
The entry point installs standard ES2023 array-copy polyfills required by the SDK
on Hermes. The UI sets component shapes, elevations and colour roles explicitly. Font sizes
respect the system text scale. Edge-to-edge layouts use one safe-area owner.
Native-stack navigation handles system and predictive back; sheets use Compose
motion and the app presents snackbars.

FlashList owns the inbox and transcript. Each visible transcript row subscribes
to its item key. Streaming text does not rebuild the full list or copy history.
The SDK retains a bounded live tail and loads historical pages on demand. The
Phase 0 stress configuration raises the tail cap to 2,200 items to measure a
2,000-item list, while production should keep the SDK's normal 200-item window.
Compose lists are reserved for small bounded UI because React creates their
children eagerly.

Expo SQLite implements the SDK's injected storage. Per-intent writes and deletes
commit in exclusive transactions, with FULL synchronous WAL. Host binding is
separate from receipt-trimmed payloads. One runtime owns a namespace per daemon
and device. It awaits client close before closing its database. Credentials,
transport, scheduler, time, randomness and IDs are injected at the app boundary.

Phase 0 connects only to an explicitly debug-only loopback fake daemon. Production
pairing must use a native pinned-TLS transport for ticket exchange and WebSocket,
store the device token in Android Keystore, and preserve device/host identity.
A pin mismatch never falls back to the React Native default WebSocket or HTTP.
Provider credentials remain on the host under ADR 0002.

## Gates and follow-up

Before advancing to the MVP, record emulator scrolling, p95 input latency no more
than 100 ms, bounded memory, and offline-send plus process-kill/relaunch replay.
Capture two profiles with different density and text scale. A Samsung-like AVD
profile is a geometry/text-scale check, not proof against the actual One UI
runtime. Physical OEM device checks remain required for release certification.

The iOS bridge gate belongs to #560. A failed JavaScriptCore gate requires a
maintainer decision before using Expo on iOS.

Phase 1 adds pairing, biometric lock, complete inbox grouping, questions, Agents,
Changes and Machines. Phase 2 needs an FCM delivery ADR before implementation.
Hosted-service setup requires explicit approval. Never put FCM service-account
or signing keys in the daemon. Notification status and actions use the canonical
notification and durable-command paths from ADR 0012.

## Phase 0 outcome

The owner accepts #565 as Phase 0 evidence, matching iOS #567. It remains an
unmerged draft with the gate held. Phase 1 waits for the owner and real-device
measurements. [The measurement report](../verification/android-phase0/README.md)
records methods, raw numbers and screenshots.

Proven in the measured emulator scope:

- Input p95 of 47.80 ms against the ≤100 ms target, with 120/120 captures and
  zero dropped reports, using intended-vsync completion timing.
- SQLite offline send and app-kill replay, with exactly one daemon admission.
- Bundled-font and fixed-theme parity in light and dark schemes.
- Layouts at 420 dpi / text scale 1.0 and 450 dpi / text scale 1.3.

Unproven:

- Scrolling. Current and legacy jank measure different things. Presentation and
  frame-timeline evidence must establish visible pacing and explain the 1,850
  high-input-latency counts in the accelerated run.
- Memory. Debug-emulator PSS was about 650–680 MiB without a plateau. A warmed,
  longer, release-like soak with native/JS/graphics allocation breakdowns is needed.
- Daemon-restart durability. The replay experiment killed the app while the daemon
  stayed running; it did not exercise a daemon restart.

## Sources

- [Expo SDK 57 reference](https://docs.expo.dev/versions/v57.0.0/).
- [Expo UI stability in SDK 56](https://expo.dev/changelog/sdk-56).
- [Host palette behaviour](https://docs.expo.dev/versions/v57.0.0/sdk/ui/jetpack-compose/host/).
- [Custom Compose theme integration](https://docs.expo.dev/versions/v57.0.0/sdk/ui/jetpack-compose/extending/).
- [Client SDK](0030-client-sdk.md), [pending sends](0066-pending-sends-and-outbox.md)
  and [remote access](0070-runtime-remote-access.md).
