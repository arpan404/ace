# iOS and Android over Tailscale

Target both platforms using the existing clients: SwiftUI with JavaScriptCore on
iOS, Expo with Compose and Hermes on Android. The shared `@ace/client` owns
reconnect, snapshots, replay, durable commands and canonical agent state.
[ADR 0073](../adr/0073-native-mobile-clients.md) and
[ADR 0074](../adr/0074-native-ios-client.md) record the stack. Both Phase 0 spikes merged
on 2026-10-12, and iOS Phase 1 is built on `ace/ios-mvp`; real-device performance
measurement is still owed. This is the implementation roadmap, not evidence that pairing
a physical phone over Tailscale already works.

## Features and porting scope

| Feature                                    | Current mobile coverage                                                                                                                                                                 | Next step                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Inbox, live transcript, history            | iOS: one inbox across every paired machine, the web's transcript blocks, history paging, full steps of finished turns. Android: Phase 0 prototype                                       | Measure on physical phones                                                            |
| Send, queued/offline sends, reconnect      | iOS: durable outbox per machine, steer or queue, queue reorder, files-only messages. Android: Phase 0 prototype                                                                         | Validate replay on a physical phone over Tailscale                                    |
| Approvals and stop tree                    | iOS: approval, question, plan, form and browser cards; Stop all and per-agent stop. Android: Phase 0 prototype                                                                          | Android parity                                                                        |
| Archive and snooze                         | iOS: archive browser, snooze presets, a snooze that ends while its machine is offline                                                                                                   | Android parity                                                                        |
| Remote sign-in to ace                      | iOS: QR/paste pairing, pinned HTTPS/WSS, Keychain tokens, Face ID. Android: deferred                                                                                                    | Pair a physical phone over Tailscale                                                  |
| Multiple computers                         | iOS: every paired machine connects at once; Machines sheet with rename, remove and coding-tool readiness                                                                                | Android parity                                                                        |
| Agents and background tasks                | iOS: Agents sheet with tree-aware status, usage and background tasks. Android: bounded Agents sheet                                                                                     | Android actions                                                                       |
| Agent questions and Changes                | iOS: question cards; Changes sheet with diff, commit, push, PR, merge and AI-drafted messages                                                                                           | Android screens                                                                       |
| Projects, files, models, account readiness | iOS: New thread (project, worktree, agent and model, effort, speed, access, first-message files), Add project, Files for a thread or a project                                          | Android screens                                                                       |
| Provider sign-in                           | iOS relays host-supervised installed CLI choices, verification URLs/codes and Enter prompts                                                                                             | Verify real provider sign-in completion                                               |
| Terminal, browser, screen/device control   | iOS has a native terminal and live JPEG/H.264 browser; screen/device control remains deferred                                                                                           | Verify browser controls against a real daemon; plan screen/device adapters separately |
| Notifications and Live Activities          | iOS: local notifications with per-machine mute ([ADR 0087](../adr/0087-ios-local-notifications.md)). Local Live Activities use foreground canonical state; remote push remains deferred | Delivery ADR and platform measurements before implementation                          |

Port shared data and commands through package public APIs. Build native screens;
desktop DOM components cannot run in SwiftUI or Compose. iOS uses the narrow
JavaScriptCore bridge, so adding SDK services also requires typed, bounded bridge
messages and native adapters. Android can call the same SDK APIs directly.

Provider authentication stays with the user's installed CLI under
[ADR 0002](../adr/0002-local-cli-providers.md). Phone access pairs to ace; it does
not require a separate provider account or an ace-hosted authentication service.
API-key submission requires the dedicated encrypted `provider_auth` channel;
ordinary Tailscale conversation sockets cannot carry it. See the
[provider sign-in contract](../daemon/provider-login.md).

## Connection and sign-in flow

1. Install and connect Tailscale on the computer and phone. Both must have access
   to the same tailnet under its access policy. Tailscale owns its VPN and login;
   ace uses the device's network rather than embedding another VPN.
2. Enable Tailscale remote access in desktop settings, or launch
   `ACE_LISTEN=tailscale node apps/daemon/src/cli.ts start`. The daemon binds its
   Tailscale IPv4 address and keeps the loopback listener. Discovery failure must
   never enable LAN as a fallback.
3. Run `ace pair` on the host, or create the pairing link in Remote devices.
   The host chooses the grants. On the phone, scan or paste that link and confirm
   the device name and host fingerprint. A code expires in five minutes and
   redeems once.
4. Strip the fragment before networking. Use the QR-confirmed SHA-256 DER SPKI pin
   for HTTPS redemption at `/v1/pair`. Store the token in iOS Keychain or Android
   Keystore-backed secure storage, together with the issued device identity.
   Bind the authenticated host identity obtained on the pinned connection; do not
   infer it from the hostname. Do not save pairing codes or tokens in SQLite,
   logs or drafts.
5. On every connection attempt, obtain a fresh `/v1/tickets` ticket over pinned
   HTTPS and open pinned WSS to the same daemon. Send the issued device ID and
   ticket in `hello`. Never send the host/admin token to a remote listener.
6. Bind SQLite and cached views to host/device identity. Await old-runtime
   shutdown before switching machines and discard its callbacks. Wi-Fi/cellular
   transitions retry through the SDK. Queued commands retain their IDs.

Both native HTTP and WebSocket adapters must check certificate validity and reject
changed pins and redirects before sending credentials. Ordinary HTTPS Serve termination changes the public
key seen by the client. Prefer the existing direct Tailscale listener; a raw TCP
forwarder is a separate deployment option documented in
[remote access](../daemon/remote-access.md).

Tailscale assigns stable IP addresses and optional MagicDNS names. Pairing links name
the machine's ts.net host while it serves Tailscale's certificate for that name, and the
100.x address otherwise. Use the
address the link advertises; a hostname is not the authenticated ace host identity.
A ts.net host may present Tailscale's publicly trusted certificate in place of the
pinned key; clients accept it only for that exact name
([ADR 0097](../adr/0097-tailscale-https-certificates.md)). Sources: [connect to devices](https://tailscale.com/docs/how-to/connect-to-devices),
[MagicDNS](https://tailscale.com/docs/features/magicdns).

## Work remaining before remote pairing

- iOS: lifecycle and lost-receipt/app-relaunch contracts pass in the simulator.
  Establish real-device rendering, hitches and input evidence; simulator
  display-link cadence does not prove FPS. No physical phones were available
  during this follow-up.
- Android: establish presentation/scroll pacing, a bounded memory plateau and
  daemon-restart durability. Emulator geometry checks do not certify OEM devices.
- iOS now has native pinned HTTP and WSS, QR/paste onboarding, Keychain tokens,
  host-bound storage, the multi-machine inbox and Face ID unlock. They run against
  a real daemon's TLS listener on loopback in the simulator (`apps/ios/README.md`).
  Still to verify: a physical phone over Tailscale.
- Verify wrong pins, expiry, revoked/read-only devices, unavailable Tailscale,
  reconnect on network changes, repeated machine switching, and lost-receipt
  replay through app and daemon restarts.

The existing relay carries auxiliary channels. It does not carry pairing or main
conversations. Remote pairing on phones is still deferred; the debug loopback
fixtures remain isolated from production access.
