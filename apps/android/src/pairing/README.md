# Android production pairing foundation

Independently testable pairing logic for the Android production path
(parity plan M02, tasks A02.01–A02.05). It is aligned with the existing iOS
pairing implementation and the existing wire contracts; it changes no shared
contract and implies no security the native transport does not yet provide.

## What is here

- `pairing-link.ts` — strict paste/QR link parsing (HTTPS only, no
  credentials or query in the URL, non-empty code, valid 64-hex pin),
  confirm-screen details (host, grant summary, fingerprint groups), and a
  fragment-free HTTPS origin plus derived WSS endpoint. Mirrors iOS
  `PairingLink.parse` and the shared fragment layout.
- `../security/trust.ts` — the only trust decision: exact SPKI pin plus
  certificate validity, with the single ADR 0097 exception for `*.ts.net`
  hosts presenting a publicly trusted certificate for that exact name.
  Pure decision logic; the native adapter supplies the leaf SPKI digest.
- `pairing-flow.ts` — confirm-then-redeem-once orchestration over an
  injected transport. Binds the authenticated `host.identity` read on the
  pinned connection, never the link hostname. Returns a `PairedMachine`
  for `MachineDirectory.add`.
- `pairing-transport.ts` — builds the flow's `PairingTransport` from
  injected pieces: `httpFor` binds one origin plus its confirmed pin to a
  `PinnedHttp` (production passes `createPinnedHttp` over the Kotlin
  `pinnedFetch` bridge), and `readIdentity` reads the authenticated host
  identity on the pinned connection. The pin is revalidated before the
  bridge is touched and the code travels only in the POST body, so nothing
  is sent without validated pinning. `unavailablePairingTransport` throws
  before any network for builds without the wiring.
- `pairing-view.ts` — pure entry/confirm view-model for the screen:
  pasted or scanned text parses into the same confirmation (single
  redemption path), with static actionable errors that never contain link
  material, plus the Pair-action gate, the mapped failure copy (safe
  `PairingFlowError` text verbatim, static fallback otherwise — raw
  scanner or transport text is never shown) and fail-closed copy.
- `pinned-pairing.ts` — production `PairingTransport` over the Expo pinned
  bridge (`../security/expo-bridge.ts`): `redeem` POSTs the code once to
  `origin/v1/pair` with the link pin validated before anything is sent, then
  a short-lived pinned identity connection reads `host.identity` on the same
  pin. Unreadable replies return raw so the flow reports `consumed`. Inactive
  until the pairing screen wires it: no production UI calls it yet.
- `../Pairing.tsx` — the entry/confirm screen mirroring iOS
  `PairingView`/`ConfirmPairingView` (paste field, scan affordance,
  address/grant/fingerprint confirmation, device name, Pair action).
  `scan` and `pair` are injected; when absent the actions stay disabled
  with guidance and the code can never leave the phone. The link field
  opts out of autofill/autocorrect (the iOS `privacySensitive` equivalent),
  and there is no cancel while pairing: Back stays disabled and unmounting
  never claims to cancel the request, because the bridge cannot cancel an
  in-flight redemption and the one-use code may already be burned.
- `credentials.ts` — device-token store contract (Keystore-backed in
  production, memory in tests), the SDK-shared `[hostId, deviceId]` key,
  and authority-first removal ordering. Tokens never enter SQLite, logs,
  drafts or error messages.
- `tickets.ts` — fresh single-use ticket exchange per connection attempt
  over the injected pinned fetch, reusing the shared `accessTicket` and
  `pairedSocketCredential` contracts. Tickets are never cached.
- `../security/pinned-transport.ts` — request policy in front of the native
  bridge, mirroring iOS `PinnedHTTP`/`PinnedSocket`: a valid 64-hex pin is
  required on every call (fail closed before any network), origins and fixed
  `/v1/` paths are validated, responses are bounded at 1 MiB, redirects are
  refused, and refusals map to `pin`/`redirect`/`offline`/`limit`/`invalid`.
  `createPinnedHttp` binds one origin plus its confirmed pin to the
  `NativePinnedHttp` bridge; `validateSocketTarget` gates WSS endpoints.
  `TrustMonitor` records a pin refusal with no reset: success never clears it
  (ADR 0097 `*.ts.net` fallback).
- `../security/expo-bridge.ts` — Expo-module adapter for the pinned bridge
  (inactive until wired): `expoBridgeFromModule` fail-closed construction,
  `bridgePinnedHttp` plus `ticketFetch` for the per-attempt ticket exchange,
  and `bridgeSocketTransport` for pinned WSS with per-socket trust reporting
  and epoch guards. No production UI imports it yet.
- `transport/` in `modules/ace-native` — the Kotlin TLS boundary: a pinning
  trust manager (SPKI pin plus validity window during the handshake, single
  ADR 0097 `*.ts.net` exception), bounded HTTPS with redirect refusal, a
  pinned WebSocket reporting `trust("pin")` before the fatal close, and the
  Expo bridge (`pinnedFetch`, `pinnedSocketOpen/Send/Close`,
  `onPinnedSocketEvent`). Socket entries are evicted by identity so a stale
  close from a replaced session never drops its replacement. JVM unit plus
  loopback integration tests cover the pin digest vector, mismatched-pin
  fail-closed with nothing written, and the trust-report ordering.

## What is deliberately missing

No QR capture (A02.06: the screen's scan affordance is injected and
fail-closed until camera wiring lands), no app lock (A02.07) and no
production startup or ticket-authenticated identity-socket wiring (A02.08:
`readIdentity` has no production reader yet, so redeeming would burn the
one-use code and the screen stays fail-closed). Until that wiring lands,
nothing here may authorize a connection: the production entry point
(`index.production.tsx`) renders the pairing screen without `scan`/`pair`,
the fixture runtime stays debug-only, and the React Native default fetch or
WebSocket must never carry pairing material. Native in-flight cancellation
is also missing: the transport honors the flow's signal fail-closed (a
pre-flight abort sends nothing; an abort racing the request stops waiting
only and surfaces `consumed`, since the code may already be burned), so the
screen offers no cancel while pairing and never claims an abort cancelled
the network.

## Integration needs

1. Pairing/startup wiring: build the `NativePinnedHttp` bridge from the Expo
   `pinnedFetch` function (`{origin, fingerprint, method, path, body, token}`
   in, `{status, body}` out, rejection message exactly the refusal) and pass
   it to `createPinnedHttp`, then supply it as `httpFor` to
   `createPairingTransport` (`pairing-transport.ts`); `redeem`/`readIdentity`
   already carry the explicit `fingerprint` every request requires,
   validated with `isPin` before any code leaves the phone. The production
   `readIdentity` behind the ticket exchange and the `host.identity` read
   still needs building over `pinnedSocketOpen/Send/Close` with
   `onPinnedSocketEvent` (`open`, `message`, `binary` as base64, `trust`,
   `close` with the numeric code). Until it exists the screen must keep
   `pair` unset: redeeming without the identity read would burn the
   one-use code.
2. `expo-secure-store` wired through `createKeystoreCredentialStore`
   (`keystore.ts`, production entry `secure-store.ts`) with the isolated
   `app.ace.android.device-token` service, no authentication prompt,
   SecureStore-safe key encoding, and Auto Backup exclusion
   (`configureAndroidBackup` in `app.json`, pinned by `backup.test.ts`).
   `keychainAccessible` is iOS-only and ignored by the Android native
   module, so the adapter never sends it. Fail-closed reads, single-key
   deletes and malformed-token handling are covered in `keystore.test.ts`.
3. Production startup (`../runtime/production-startup.ts`) routes empty,
   removed and revoked pairings back to pairing (`startupRoute`: missing,
   revoked, pin mismatch and unsupported relay entries; offline/storage
   failures stay paired while the SDK retries), requests a fresh ticket per
   connection, and keeps the fixture transport debug-only. The grant helpers
   (`GrantStore`/`canOperate`) are admission checks only: the app's real
   mutations are not yet routed through `runtimeForMutation`, so view-only
   enforcement is not demonstrable end to end and the production entry point
   (`index.production.tsx`) stays unwired.
4. Camera capture for the screen's scan affordance (A02.06): grant/denial,
   cancel and malformed QR must all funnel into the screen's single
   `acceptPairingText` path without a second redemption path and without
   logging the code.

## Verification limits (no emulator)

- The pairing screen (`../Pairing.tsx`) has no renderer test: the unit
  project runs logic tests only, so coverage is the view-model
  (`pairing-view.test.ts`), the transport adapter end to end against the
  real redemption flow (`pairing-transport.test.ts`), `tsc`, and review
  against the iOS `PairingView`/`ConfirmPairingView` behavior above.
  Exercise entry, confirm, error and fail-closed states on a physical phone
  before shipping.
- `backup.test.ts` pins the checked-in `app.json` flag that generates the
  backup exclusion, not the generated manifest. After any Expo SDK bump or
  `app.json` edit, run `expo prebuild --platform android` and confirm the
  manifest references the SecureStore backup/data-extraction rules before
  shipping.
