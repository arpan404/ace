# 0106: iOS remote push through ace's push gateway

Status: accepted. Date: 2026-10-27. Owner decision of 2026-10-27. Amends
[ADR 0002](0002-local-cli-providers.md) (a narrow hosted exception), refines
[ADR 0012](0012-notifications.md) and [ADR 0087](0087-ios-local-notifications.md), and
supersedes the alert half of [drafts/ios-push-notifications.md](drafts/ios-push-notifications.md).
Live Activity push stays in the draft.

## Context

ADR 0087 shipped local notifications only. A phone whose app is suspended or closed sees missed
alerts when iOS runs background refresh, or when the person opens the app. Only APNs can wake the
phone, and only the holder of ace's Apple team key can push to the App Store or TestFlight build
(see the draft for the full analysis). So a push for the shipped app has to pass through a
service ace runs.

ADR 0087 also found that an open but suspended socket can count as delivered. The `appState`
flag covers the normal case (the app says it left the foreground), but a phone that is suspended
before that frame leaves still looks live.

## Decision

### The exception

ace runs one small service, the **push gateway** (`apps/push-gateway`). It is an exception to
ADR 0002's "no hosted mode", limited to this:

- It forwards opaque, end-to-end encrypted alert payloads from a person's own daemon to APNs.
- It holds ace's APNs auth key and its own handle-sealing key. It holds no provider
  credentials, no ace account, no device directory and no database.
- It sees: the APNs device token, the daemon's public key, the daemon's IP, timing, size and
  urgency. It never sees thread titles, statuses, ids, questions, previews, code or prompts.
- It logs counts and status codes only. Tokens, handles, keys, IPs and bodies are never logged.
- Nothing travels back through it. Approvals and every other answer go over the paired, pinned
  daemon connection, as before.

Self-builders can run the same image with their own key and point their daemons at it.

### Privacy model: end-to-end encrypted alerts

The daemon encrypts each alert to the phone with RFC 8291 (`aes128gcm`), the same vector-tested
code its Web Push transport uses. The phone generates the P-256 key and 16-byte auth secret, and
sends the public half to each paired daemon over the authenticated socket. The private half
stays on the phone, in the app group shared with the Notification Service Extension (NSE).

The gateway builds the visible APNs payload itself: a fixed "ace" / "New activity" alert,
`mutable-content: 1`, and the ciphertext in one custom key. The daemon can't put visible text
on anyone's lock screen through the gateway. The NSE decrypts, builds the alert with the same
wording code the app uses for local notifications (`AlertContent`) and replaces the text. If
anything fails (no key after a reinstall, tampered or malformed data, timeout), the generic text
stays. **The fallback never says done.**

**Why not content-free wake-and-fetch.** The task preferred a content-free push plus an NSE that
fetches the alert from the paired daemon. That was rejected: the NSE has about 30 seconds and a
small memory budget, and fetching would need the whole pinned TLS or Noise relay client, the
ticket exchange and the JavaScript runtime inside the extension. It would also fail whenever the
phone can't reach the daemon (cellular without Tailscale, computer asleep with the relay down),
which is exactly when a push matters. Encrypted payloads give the same privacy (the gateway and
Apple see ciphertext only) and work offline. The encrypted payload is the bounded
`Notification` object from `protocol/notifications.ts` plus the daemon's host id; it never
carries more than the local path shows.

### Gateway contract (v1)

Every request carries RFC 8292 VAPID authorization, `Authorization: vapid t=<jwt>, k=<key>`.
The JWT is ES256, its `aud` is the gateway's public origin and its `exp` is in the future and no
more than 24 hours away. The daemon's identity is the SHA-256 of its public key. Each daemon
generates its key on first start (`push-key.pem` in its data directory, mode 0600). No sign-up.

- `POST /v1/registrations` `{ token, environment: "sandbox" | "production" }` returns
  `201 { handle, expiresAt }`. The handle is the token, environment, daemon key hash and expiry,
  sealed with AES-256-GCM under the gateway's sealing key. The gateway keeps nothing. Handles
  last 30 days; the daemon re-registers before expiry and whenever the phone registers again.
- `POST /v1/push/<handle>` with an RFC 8030 body: `Content-Encoding: aes128gcm`, `TTL`
  (seconds, at most a day, becomes `apns-expiration`), `Urgency` (`high` and `normal` send at
  priority 10 as an active alert, `low` and `very-low` at priority 5 as a passive one) and an
  optional `Topic` (up to 32 base64url characters, becomes `apns-collapse-id`). The handle must
  have been sealed for the requesting daemon's key: **a daemon can push only to tokens it
  registered**, and a leaked handle is useless without that daemon's private key.
- `GET /healthz` returns 200.

Responses: `201` accepted; `400` malformed; `401` bad or missing authorization; `403` the handle
belongs to another daemon; `404` the handle is unreadable or expired (re-register); `410` APNs
said the token is no longer valid (`Unregistered`, `BadDeviceToken`, `DeviceTokenNotForTopic`);
`413` the body is over 2,800 bytes or the APNs payload would pass 4,096; `429` a limit, with
`Retry-After`; `502` / `503` APNs failed or is unreachable (retry). The daemon maps 404 to a fresh
registration, 410 to an expired address (ADR 0012's `gone`), 429 and 5xx to a retry with
backoff, and everything else to a permanent failure.

APNs is reached over HTTP/2 with token authentication: an ES256 provider JWT from the team id and
key id, refreshed every 50 minutes, `apns-push-type: alert`, the configured bundle id as topic,
and `api.push.apple.com` or `api.sandbox.push.apple.com` chosen by the handle's environment. The
HTTP/2 client is `@ace/notify/apns-client`, shared with the daemon's older direct APNs transport.
A token APNs reports invalid is remembered (as a hash, bounded, 30 days), so further pushes and
registrations for it get 410 without another APNs call.

### Abuse limits

In-memory token buckets, bounded maps with oldest-first eviction, injectable clock:

| Limit                             | Default      |
| --------------------------------- | ------------ |
| Requests per client IP (IPv6 /64) | 600 per hour |
| Registrations per daemon key      | 60 per hour  |
| Pushes per daemon key             | 600 per hour |
| Pushes per handle (one phone)     | 120 per hour |
| Request body                      | 2,800 bytes  |
| Concurrent APNs requests          | 64           |

Anyone can generate a key, so per-key limits alone don't stop a determined sender; the per-IP
limit does most of that work, and the gateway's own visible text is fixed, so the worst case is a
generic "New activity" alert to a token the sender already knows. Device tokens only ever go to
the person's own paired daemons. App Attest is a possible later hardening.

### Daemon

- New notification address `{ channel: "push", platform: "phone", token, environment, p256dh,
auth }` (`protocol/notifications.ts`). The token is hex of variable length (Apple says not to
  hard-code its size). The phone registers it once per connection while alerts are on.
- `createPushGatewayTransport` (`@ace/notify`) seals each alert, registers and caches handles
  in memory, and posts to the gateway. Plaintext is trimmed to a fixed budget (preview, then
  message, then the catch-up list are dropped) so a body is never refused for size.
- ADR 0012 policy stays the only alert policy: snooze, quiet hours, presence suppression,
  `agentSays`, mute (`notification.unregister`) and revocation all run before the transport.
- **Delivery to a phone with a push address now needs an acknowledgment.** The daemon sends the
  `notification` frame to the phone's foreground sockets and waits up to 3 seconds for
  `notification.ack { id }`. Without one (the app is suspended with its socket open, or the frame
  was lost) the router falls through to push. Phones without a push address keep ADR 0087's
  behaviour. A duplicate is possible only when the ack itself is lost; the app skips a local
  alert whose id is already on screen from a push.
- Settings: `notifications.remotePush` (default on) turns push off for every phone of this
  machine; phones then behave as in ADR 0087. `notifications.pushGatewayUrl` (default
  `https://push.acehq.dev`, overridable with `ACE_PUSH_GATEWAY_URL`) points at another gateway.
  Only HTTPS is accepted, or HTTP on 127.0.0.1 for tests.
- The direct `ACE_APNS_*` transport is unchanged for self-builders. Removing it stays an owner
  decision (draft item 6).

### iOS

- After notification permission is granted, the app calls `registerForRemoteNotifications`.
  The token, its environment (`sandbox` in Debug builds, `production` otherwise) and the app's
  push key go to the bridge, which registers the push address with every paired machine on each
  connection, and again whenever the token changes. Turning alerts off for the phone or a machine
  still unregisters (ADR 0087). Unpairing forgets the machine; the daemon's revocation removes
  the address.
- The key pair is generated once and kept in the app group container (`group.app.ace.ios`)
  with complete-until-first-unlock protection, so the NSE can read it on a locked phone.
- `AceNotificationService` (NSE) decrypts with CryptoKit and fills in title, body, grouping,
  category, interruption level and the same `userInfo` keys a local alert carries. Taps and the
  Allow / Deny actions route exactly as local notifications do today.
- The entitlement `aps-environment` and the app group are declared in `project.yml`.

### Turning it off

- Per machine: Settings › Notifications › "Push when the app is closed" on iOS, and the same
  switch in the web app's Notifications settings. Both write `notifications.remotePush` on that
  machine. The sentence beside it says the push goes through ace's push service and that the
  service sees only encrypted data.
- Per phone: turning notifications off in the app, or in iOS Settings, stops everything.
- Self-builders and privacy-minded people can point `notifications.pushGatewayUrl` at their own
  gateway.

## Consequences

- Alerts reach a suspended or closed app within seconds, not on iOS's background refresh
  schedule.
- ace now operates one internet service, with an on-call duty for key rotation and uptime. If the
  gateway is down, alerts fall back to ADR 0087's catch-up; nothing is lost from the feed.
- Apple and the gateway learn when a phone gets an alert and roughly how big it is.
- An accepted push can't be recalled. A "Done" that becomes stale is withdrawn by catch-up when
  the app next runs, as today.

## Verification

- `apps/push-gateway/src/*.process.test.ts`: the real gateway process against a local HTTP/2
  fake APNs with a generated ES256 key. JWT and headers verified; topic, priority, expiry,
  collapse id; handles bound to one daemon; expired and foreign handles; `Unregistered` and
  `BadDeviceToken` become 410 and are remembered; every limit; oversize; logs carry no token or
  handle. No real APNs, no real keys.
- `packages/notify/src/push-gateway.process.test.ts`: the daemon transport against a real local
  gateway: encryption decrypts with the phone's key, handle caching and re-registration, status
  mapping.
- `apps/daemon/src/notification-push.server.process.test.ts`: a phone that acknowledges gets no
  push; a phone that doesn't (suspended with its socket open) gets one; the setting turns it off.
- iOS: Swift tests decrypt a Node-made RFC 8291 vector and fail closed on tampering; `xcrun simctl
push` on the simulator shows the NSE's text, and the generic fallback without a key.

## Deploy checklist (owner)

Nothing below can be done from the repository. Until it is done, phones keep ADR 0087 behaviour:
the app gets no APNs token without the entitlement, and a daemon with no push address never calls
the gateway.

1. **Apple Developer team.** Confirm the team that owns `app.ace.ios` and note its Team ID.
2. **Identifiers.** In Certificates, Identifiers & Profiles: enable Push Notifications and App
   Groups on `app.ace.ios`; create `app.ace.ios.notifications` (the NSE) with App Groups; create
   the app group `group.app.ace.ios` and add it to both. Regenerate provisioning profiles.
3. **APNs key.** Keys › create a key with Apple Push Notifications service, for Sandbox &
   Production (or one key per environment). Download the `.p8` once and note its Key ID. Never
   commit it; keep it only in the gateway's secret store.
4. **Sealing key.** Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
5. **Hosting.** Choose where the container runs (a small VPS or container service; Cloudflare
   Workers can't hold the long-lived HTTP/2 connection APNs wants). It needs outbound TCP 443 to
   Apple and inbound HTTPS from the internet with TLS terminated in front (Caddy, a load
   balancer or the platform's proxy). The proxy must pass the client IP in `X-Forwarded-For` and
   `ACE_PUSH_TRUST_PROXY=1` must be set, or every client shares one rate-limit bucket.
6. **Domain.** Point `push.acehq.dev` (or the chosen name) at it. If the name differs, change
   the default in `packages/settings/src/defaults.ts` and the gateway's
   `ACE_PUSH_PUBLIC_ORIGIN`.
7. **Secrets and environment** for the container (`apps/push-gateway/Dockerfile`):
   - `ACE_PUSH_APNS_TEAM_ID`, `ACE_PUSH_APNS_KEY_ID`
   - `ACE_PUSH_APNS_KEY_FILE` (path to the mounted `.p8`) or `ACE_PUSH_APNS_KEY` (its contents)
   - `ACE_PUSH_APNS_TOPIC=app.ace.ios`
   - `ACE_PUSH_SEAL_KEY` (step 4); during rotation also `ACE_PUSH_SEAL_KEY_PREVIOUS`
   - `ACE_PUSH_PUBLIC_ORIGIN=https://push.acehq.dev`
   - `ACE_PUSH_TRUST_PROXY=1`, optionally `ACE_PUSH_PORT` (default 8788)
8. **Smoke test.** `curl https://push.acehq.dev/healthz`. Then, on a real phone with a
   development build, turn on notifications, lock the phone and let an agent finish: the alert
   should read the thread title, not "New activity".
9. **App Store privacy.** Declare the device token as data collected for app functionality, not
   linked to identity, not used for tracking.
10. **Monitoring and rotation.** Alert on the gateway's 5xx rate. To rotate the APNs key: create
    the new key, deploy it, revoke the old one. To rotate the sealing key: move the current one
    to `ACE_PUSH_SEAL_KEY_PREVIOUS` and set a new `ACE_PUSH_SEAL_KEY`; daemons re-register as
    handles fail.
