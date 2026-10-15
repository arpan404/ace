# iOS and Android over Tailscale

Target both platforms using the existing clients: SwiftUI with JavaScriptCore on
iOS, Expo with Compose and Hermes on Android. The shared `@ace/client` owns
reconnect, snapshots, replay, durable commands and canonical agent state.
[ADR 0073](../adr/0073-native-mobile-clients.md) and
[ADR 0074](../adr/0074-native-ios-client.md) hold Phase 1 until the performance
gates pass. This is the implementation roadmap, not evidence that remote phone
pairing already works.

## Features and porting scope

| Feature                                    | Current mobile coverage                                   | Next step                                                       |
| ------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------- |
| Inbox, live transcript, history            | Both debug prototypes use the shared SDK                  | Keep bounded subscriptions and whole-tree status for real hosts |
| Send, queued/offline sends, reconnect      | Both prototypes persist intents in SQLite                 | Validate paired TLS and daemon restart as well as app restart   |
| Approvals and stop tree                    | Both prototypes expose canonical commands                 | Preserve exact action IDs, grants and waiting states            |
| Archive and snooze                         | iOS exposes commands                                      | Complete inbox actions on both platforms                        |
| Remote sign-in to ace                      | Daemon pairing, device scopes and tickets already exist   | Add native QR/paste onboarding and secure device credentials    |
| Multiple computers                         | SDK has machine APIs; mobile UI is deferred               | Add machine directory, host-bound storage and safe switching    |
| Agents and background tasks                | Android has a bounded Agents sheet; iOS sheet is deferred | Complete native tree views and actions after pairing            |
| Agent questions and Changes                | Canonical services exist; mobile screens are deferred     | Add question answers and native changes sheets after pairing    |
| Projects, files, models, account readiness | Shared client APIs exist                                  | Add focused phone views with capability/scope checks            |
| Provider sign-in                           | Host supervises reviewed installed CLI flows              | Relay only supported verification URLs/codes and fixed progress |
| Terminal, browser, screen/device control   | Separate service channels exist                           | Design phone controls and native transport adapters separately  |
| Notifications and Live Activities          | Deferred Phase 2                                          | Delivery ADR and platform measurements before implementation    |

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

Tailscale assigns stable IP addresses and optional MagicDNS names. Use the address
advertised by the host's pairing link; a hostname is not the authenticated ace
host identity. Sources: [connect to devices](https://tailscale.com/docs/how-to/connect-to-devices),
[MagicDNS](https://tailscale.com/docs/features/magicdns).

## Work remaining before remote pairing

- iOS: lifecycle and lost-receipt/app-relaunch contracts pass in the simulator.
  Establish real-device rendering, hitches and input evidence; simulator
  display-link cadence does not prove FPS. No physical phones were available
  during this follow-up.
- Android: establish presentation/scroll pacing, a bounded memory plateau and
  daemon-restart durability. Emulator geometry checks do not certify OEM devices.
- After the gates: implement native pinned HTTP and validate WSS against a real
  paired daemon, secure storage, onboarding, biometric unlock and machine views.
- Verify wrong pins, expiry, revoked/read-only devices, unavailable Tailscale,
  reconnect on network changes, repeated machine switching, and lost-receipt
  replay through app and daemon restarts.

The existing relay carries auxiliary channels. It does not carry pairing or main
conversations. Remote pairing on phones is still deferred; the debug loopback
fixtures remain isolated from production access.
