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

No QR capture (A02.06), no app lock (A02.07) and no production startup or
ticket wiring (A02.08). Until that wiring lands, nothing here may authorize
a connection: the production entry point (`index.production.tsx`) stays
unpaired, the fixture runtime stays debug-only, and the React Native
default fetch or WebSocket must never carry pairing material.

## Integration needs

1. Pairing/startup wiring: build the `NativePinnedHttp` bridge from the Expo
   `pinnedFetch` function (`{origin, fingerprint, method, path, body, token}`
   in, `{status, body}` out, rejection message exactly the refusal) and pass
   it to `createPinnedHttp`; `PairingTransport.redeem`/`readIdentity` already
   carry the explicit `fingerprint` every request requires, validated with
   `isPin` before any code leaves the phone. The WSS socket behind the
   ticket exchange and the `host.identity` read uses
   `pinnedSocketOpen/Send/Close` with `onPinnedSocketEvent` (`open`,
   `message`, `binary` as base64, `trust`, `close` with the numeric code).
2. `expo-secure-store` wired through `createKeystoreCredentialStore`
   (`keystore.ts`, production entry `secure-store.ts`) with the isolated
   `app.ace.android.device-token` service, no authentication prompt,
   SecureStore-safe key encoding, and Auto Backup exclusion
   (`configureAndroidBackup` in `app.json`, pinned by `backup.test.ts`).
   `keychainAccessible` is iOS-only and ignored by the Android native
   module, so the adapter never sends it. Fail-closed reads, single-key
   deletes and malformed-token handling are covered in `keystore.test.ts`.
3. Production startup that routes empty, removed and revoked pairings to
   pairing again, requests a fresh ticket per connection, and keeps the
   fixture transport debug-only.

## Verification limits (no emulator)

- `backup.test.ts` pins the checked-in `app.json` flag that generates the
  backup exclusion, not the generated manifest. After any Expo SDK bump or
  `app.json` edit, run `expo prebuild --platform android` and confirm the
  manifest references the SecureStore backup/data-extraction rules before
  shipping.
