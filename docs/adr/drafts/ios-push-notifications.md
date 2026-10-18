# Draft: iOS push notifications and Live Activities

Date: 2026-10-18. Status: **Proposed, deferred by owner 2026-10-18.** iOS ships local notifications
first ([ADR 0087](../0087-ios-local-notifications.md)); this design is kept for when remote push is
revisited. ADR 0087 covers the backgrounded-phone router case (contradiction 5) for local delivery.
Refs #560 (MVP item 8). Builds on [ADR 0012](../0012-notifications.md),
[ADR 0070](../0070-runtime-remote-access.md), [ADR 0073](../0073-native-mobile-clients.md)
and [ADR 0074](../0074-native-ios-client.md).

## The problem

A phone that is locked, or whose app is suspended, can only be woken by Apple Push
Notification service (APNs). Every APNs request is signed with a `.p8` key that
belongs to the Apple Developer team that owns the app's bundle id. Apple ties each
device token to one app on one device, and one connection to one team
([token auth](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns),
[registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns)).

So for the App Store or TestFlight build, **only the holder of ace's team key can
wake the phone.** A user's own key cannot. A user who builds the app under their own
team needs their own key and a paid membership: free accounts don't get the Push
Notifications or Time Sensitive capabilities
([supported capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-ios)).

The constraints:

- #560: no APNs signing key ships in the daemon.
- ADR 0073: no FCM service-account or signing key in the daemon. Any hosted setup
  needs explicit approval.
- ADR 0002: ace has no hosted mode and never touches provider credentials.
- AGENTS.md priority 1: never notify "done" while any part of the tree is working or
  waiting on a human.

## Options for who holds the key

| Option                                      | Who holds the key   | Works with App Store build   | Server needed | What Apple / server sees                                | Fits constraints                                        |
| ------------------------------------------- | ------------------- | ---------------------------- | ------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| A. Daemon sends to APNs directly (today)    | Every user's daemon | No                           | None          | Apple sees title, status, ids in plaintext              | **No.** Key in daemon. Self-built only.                 |
| B. ace-operated push gateway                | ace, on the gateway | Yes                          | ace runs one  | Gateway: device token, timing, size. Apple: ciphertext. | Yes, if owner approves a narrow hosted service          |
| C. Self-hosted push gateway (same software) | The user            | No (self-built app only)     | User runs one | Same as B, but the user is the operator                 | Yes. Niche: needs $99/yr and an own build               |
| D. No server: local notifications only      | Nobody              | Yes                          | None          | Nothing                                                 | Yes, but unreliable when backgrounded                   |
| E. Third-party push vendor (Firebase, etc.) | The vendor          | Yes, with ace's key uploaded | Vendor        | Vendor sees the same as B, plus their own analytics     | Worse than B: adds a vendor and still needs the key     |
| F. Home Screen web app with Web Push        | Nobody (VAPID only) | Not the native app           | None          | Apple web push service sees ciphertext                  | Yes, today, but not the native app and no Live Activity |

Notes:

- **A** exists now: `apps/daemon/src/notification-config.ts` reads `ACE_APNS_KEY_FILE`
  into the daemon. It contradicts #560 and only works for a self-built app. See
  [Contradictions](#contradictions-found).
- **D** can't replace push. iOS suspends a backgrounded app shortly after it leaves
  the foreground, and background app refresh runs only when the system decides. It
  stays as the in-app path when the app is connected.
- **F** is a useful stopgap. Apple's web push needs no developer membership
  ([web push](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)),
  and the daemon already implements RFC 8291 Web Push. It needs a trusted HTTPS web
  origin and a Home Screen install.

## Recommendation

**Option B, built so that C is the same software.** ace runs one small, stateless
push gateway. It holds ace's APNs key and nothing else. The daemon encrypts every
alert to the phone's key before it leaves the machine, and the gateway forwards
opaque ciphertext to Apple. The gateway has no accounts and no device directory. It
never learns which computer or person a phone belongs to, and it never carries
approvals. Self-builders run the same container image with their own key.

The gateway speaks the Web Push protocol (RFC 8030 + RFC 8291 + VAPID) on its input
side, so the daemon reuses its existing, vector-tested Web Push transport. In effect
the gateway is a Web Push service for the native app.

This is a hosted service. ADR 0002 says ace has no hosted mode. Approval means
amending ADR 0002 with a narrow exception: "ace may operate a push gateway that
sees device tokens and ciphertext only". Provider credentials, prompts, code and
transcripts never reach it.

## Design

### Parts

```
phone app ──(1) device token──▶ push gateway ──(2) sealed handle──▶ phone app
phone app ──(3) notification.register {endpoint, p256dh, auth} over pinned WSS──▶ daemon
daemon ──(4) RFC 8291 ciphertext + VAPID──▶ gateway ──(5) APNs alert, mutable-content──▶ Apple ──▶ phone NSE decrypts
phone (action) ──(6) interaction.resolve over pinned WSS──▶ daemon
```

- **Daemon** (`@ace/notify`): unchanged policy, queue, whole-tree rules. Sends phone
  alerts through the Web Push transport. Holds only its own VAPID key, which it
  generates itself. No Apple key.
- **Push gateway** (new `apps/push-gateway`, Node 24 container like `apps/relay`):
  turns Web Push requests into APNs requests. It reuses the bounded HTTP/2 APNs
  client now in `packages/notify/src/apns.ts`, which moves there.
- **iOS app**: registers, holds the decryption key in a Keychain access group shared
  with its extensions.
- **Notification Service Extension (NSE)**: decrypts and fills in the alert text.
- **Widget extension**: renders the Live Activity.

### Gateway contract

The gateway stores no device directory. A handle is a sealed capability:
`AEAD(gatewayKey, {apnsToken, kind, environment, topic, vapidKeyHash?, expiresAt})`.

- `POST /v1/handles` from the phone: `{apnsToken, kind: "alert" | "liveactivity",
environment: "sandbox" | "production"}` → `{endpoint, expiresAt}`. The endpoint is
  `https://<gateway>/v1/push/<handle>`. Handles last 30 days. The app refreshes on
  every launch, because Apple says not to cache tokens.
- `POST /v1/push/<handle>` from the daemon: RFC 8030 request. Required headers:
  `Content-Encoding: aes128gcm`, `TTL`, `Urgency`, VAPID `Authorization`. Optional
  `Topic` becomes `apns-collapse-id` (Apple caps it at 64 bytes).
  - The first accepted push binds the handle to that VAPID public key, as Apple's
    web push does. Later pushes with another key are rejected. A leaked handle alone
    can't be used, and a second daemon can't hijack it.
  - Alerts: the gateway builds `aps` itself. It uses a fixed, localized generic alert
    ("ace" / "New activity"), `mutable-content: 1`, a fixed category and
    `interruption-level` from `Urgency`. The ciphertext goes in one custom key. The
    daemon can't inject visible text through the gateway.
  - Body limit: the APNs payload must fit 4,096 bytes
    ([request limits](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)).
    The gateway rejects encrypted bodies over 2,900 bytes with 413. The daemon trims
    its plaintext to a budget first, so this never fires in normal use.
  - Response codes: 201 accepted; 404/410 gone (APNs `Unregistered` / `BadDeviceToken`,
    expired or denylisted handle); 429 and 5xx retry; other errors permanent. These map
    to the existing `httpDeliveryStatus`.
- `DELETE /v1/push/<handle>` from the phone or daemon: adds the handle's hash to a
  denylist until the handle expires. This is the only state the gateway keeps, and
  it is bounded by handle expiry.
- Limits: per-handle rate limit (default 120 alerts/hour), per-IP registration limit,
  bounded bodies and timeouts, no redirects. Logs hold counts and status codes only.
  No tokens, handles or bodies are logged.
- APNs key: one environment-specific key per environment. Apple allows two per
  environment, which permits an overlap during rotation. JWTs refresh every 20 to
  60 minutes.

### Registration over the authenticated socket

1. The user enables notifications in the app and grants `UNUserNotificationCenter`
   permission. Push is opt-in per device.
2. The app gets its APNs token. Apple says token length varies.
3. The app generates a P-256 key pair and a 16-byte auth secret. It stores them in
   the shared Keychain access group, readable by the NSE after first unlock
   (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`).
4. The app requests an alert handle from the gateway.
5. Over the existing pinned WSS session (ADR 0070, ADR 0074), the app sends
   `notification.register { device: { channel: "webpush", platform: "phone",
subscription: { endpoint, p256dh, auth } } }` with a `requestId`. The daemon
   stores it in the private notification database, as it already does for Web Push.
   Identity comes from the authenticated connection.
6. On a token change, reinstall or key rotation, the app repeats steps 2–5. The new
   registration replaces the old one, and the app deletes the old handle.

The key exchange happens over the pinned, authenticated socket that pairing already
established. This is "key exchange during pairing" in practice. It is re-run at
registration time, so keys rotate without re-pairing. Neither the gateway nor Apple
ever sees the key or the auth secret.

The daemon only posts to gateway origins on its Web Push allowlist. The default
allowlist holds the official gateway origin, and self-hosters add theirs. This keeps
a paired device from making the daemon post to an arbitrary URL. The daemon should
generate its VAPID key at first start rather than requiring `ACE_VAPID_KEY_FILE`.
This is self-healing and needs no setup.

### Encryption

The daemon encrypts exactly the bounded `Notification` object from
`protocol/notifications.ts`, with RFC 8291 `aes128gcm`. It uses a new ephemeral ECDH
key and salt per message. This is the existing `encryptWebPush`, already tested against
the RFC's example ciphertext.

The NSE decrypts with CryptoKit (`P256.KeyAgreement`, `HKDF<SHA256>`, `AES.GCM`). The
Swift decoder must pass the same RFC 8291 vector and a cross-language vector made by
the Node encoder.

Apple sees: device token, time, size, priority and the generic alert. The gateway
sees the same, plus the daemon's IP and VAPID key hash. Neither sees thread titles,
status, ids, questions or code.

### Notification Service Extension

APNs runs the NSE only when the payload has `mutable-content: 1` and a visible alert.
The NSE has about 30 seconds; if time runs out, iOS shows the original alert
([modifying content](https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications)).

The NSE:

1. Decrypts and parses the payload with a strict, bounded decoder. Unknown fields are
   ignored, and oversized or malformed input fails closed.
2. Sets title to the thread title and body to a fixed status phrase ("Needs you",
   "Done", "Failed", "Not responding", "3 background tasks done", or the "Agent says"
   message). With preview consent, it also shows the preview.
3. Sets `threadIdentifier` (grouping), `targetContentIdentifier` (deep link),
   `categoryIdentifier` (approval actions only when `actions` is non-empty) and
   `interruptionLevel`.
4. On any failure, such as a missing key after reinstall, decrypt error or timeout,
   it leaves the generic "New activity" text. **The fallback text never says done.**

Interruption levels
([time-sensitive](https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel/timesensitive)):

| Status                                 | Level                              | APNs priority |
| -------------------------------------- | ---------------------------------- | ------------- |
| needs_you                              | `timeSensitive` (user can disable) | 10            |
| done, failed, unresponsive, agent_says | `active`                           | 10            |
| background_done                        | `passive`                          | 5             |

`Urgency: high` maps to priority 10 and `normal` to 5. Time Sensitive needs its
capability on the app. Phase C must check whether the NSE can raise the level from
the outer payload. If not, the gateway sets `time-sensitive` from `Urgency`, which
shows Apple only that this is an urgent alert.

### Actionable approve and deny

- Categories: `ACE_APPROVAL` with Approve and Deny. Both use `.authenticationRequired`,
  which requires an unlocked device
  ([authenticationRequired](https://developer.apple.com/documentation/usernotifications/unnotificationactionoptions/authenticationrequired)).
  Deny is `.destructive`. `ACE_THREAD` has no actions and opens the thread.
- Buttons appear only when the daemon put option ids in `actions`. ADR 0012 already
  limits that to the fixed approve/deny case. Anything sensitive opens the app, which
  fetches current interaction details first.
- On tap, the app gets background time. It loads the device token from Keychain, gets
  a fresh ticket over pinned HTTPS, opens pinned WSS and sends a durable `command`
  with `interaction.resolve` and the exact `optionId`. The SDK outbox gives it a stable
  command id. The engine's first-answer-wins check and the daemon's scope checks
  (operate scope) still apply. A notification grants no authority.
- If the daemon is unreachable, for example with Tailscale off or the computer
  asleep, the app keeps the command in the durable outbox. It posts a local
  notification: "Couldn't reach <host>. Open ace to retry." It never shows the
  approval as done until a canonical update closes it.
- **No response travels through the gateway or APNs.**

### Live Activity for a working thread

What it shows: one thread's **whole-tree** state, with elapsed time, the number of
working agents and the number waiting on you. It never shows the root agent's own
turn state.

Start:

- Phase D starts activities only from inside the app: a "Follow on Lock Screen"
  action on a thread, and an optional auto-follow when the user sends from the phone
  and leaves the app. The static attributes (thread title, host name) are set locally
  and never pass through a push.
- Push-to-start (iOS 17.2+) is deferred. Its start payload must carry an alert and
  the attributes in plaintext
  ([ActivityKit push](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications)).
- Broadcast channels are not used. They are for many viewers of one event.

Tokens: the app reads `activity.pushTokenUpdates`, requests a gateway handle with
`kind: "liveactivity"` and sends a new additive message:
`liveActivity.register { threadId, activityId, endpoint, frequentUpdates }`. A
replaced token re-registers, and `liveActivity.unregister` removes it. The handle's
kind is sealed, so a Live Activity handle can't send alerts and an alert handle can't
send Live Activity updates. The gateway uses `apns-push-type: liveactivity` and topic
`<bundle>.push-type.liveactivity`.

**Privacy limit:** iOS decodes Live Activity `content-state` itself, and no NSE runs.
These payloads can't be end-to-end encrypted. `content-state` therefore carries only:

```
{ state: "working" | "needs_you" | "done" | "failed" | "unresponsive",
  working: Int, waiting: Int, startedAt: Date, seq: Int }
```

The gateway validates this exact schema and rejects anything else. Apple and the
gateway see this status and these counts. Live Activities are off until the user
turns them on, and the toggle says so. A later option is a sealed field that the
widget view decrypts from the shared Keychain. That needs a prototype first.

Update rules, implemented as a pure scheduler in `@ace/notify` that is tested on its own:

- Inputs are the worker's canonical thread status and its bounded counts.
  `wake.expected` keeps the state "working", as in ADR 0012.
- A state transition is sent at once. `needs_you`, `failed` and leaving `needs_you`
  use priority 10. Others use 5.
- A count-only change uses priority 5. It is sent at most every 30 seconds per
  activity, and an unchanged state is never sent.
- Elapsed time uses `Text(timerInterval:)` in the widget, so it needs no pushes.
- Every update sets `stale-date` to now + 15 minutes. While the thread works, the
  daemon sends a priority-5 heartbeat every 10 minutes. If the daemon goes offline,
  the activity turns stale and shows "Not updated since 14:02", not a frozen
  "Working".
- `NSSupportsLiveActivitiesFrequentUpdates` is on. The app reports the user's
  frequent-updates setting, and the scheduler doubles its intervals when it's off.
- Quiet hours and snooze downgrade every update to priority 5 with no alert.

End:

- Send `event: end` only when the whole tree is `done` or `failed`, after the
  five-second burst window, with no pending interactions and no wake grace. Include
  the final state. Use `dismissal-date` now + 1 hour. The end carries no alert; the
  normal notification covers it.
- If the thread returns to work before the end is sent, the end is cancelled, as
  ADR 0012 already cancels stale done alerts.
- iOS ends an activity after 8 hours, and it can stay on the Lock Screen up to 4 more
  ([limits](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities)).
  At 7 h 50 m the daemon ends it with state "working", and the widget reads "Still
  working. Open ace." The app offers to follow again.
- Static plus dynamic data must stay under 4 KB. The schema above is far below that.
- Unfollowing, unpairing or revocation ends the activity locally and unregisters it.

### Whole-tree correctness (AGENTS.md priority 1)

- Alerts and Live Activity state come only from core's authoritative
  `thread.updated.status`, through the existing worker. Clients and the gateway never
  derive status.
- The NSE fallback and the stale Live Activity never say done.
- An APNs alert that has been accepted can't be recalled. If a thread goes done →
  working after the alert went out:
  - the Live Activity updates to working;
  - the app removes delivered notifications that no longer match canonical state each
    time it opens;
  - the alert text reads "Done at 14:02", a timestamped fact, not "is done".

  A silent superseding push would need Apple's
  [filtering entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.usernotifications.filtering),
  which requires an application to Apple. It is listed as a follow-up.

### Suppression: reuse ADR 0012

Quiet hours, per-thread snooze, presence suppression and the `agentSays` preference
all apply unchanged. They are checked at delivery time and before retries. iOS Focus
works on top of them.

One change is required. Today the router counts any open websocket for the device as
delivered (`router.ts`). A backgrounded iPhone can leave its socket open while
suspended, so the alert would be silently lost.

For `platform: "phone"`:

- websocket delivery counts only if the app reported `appState: "foreground"` in a
  presence update less than 60 seconds old;
- the app must acknowledge the `notification` message within 5 seconds;
- otherwise the transport falls through to push.

Duplicates are safe, because notification ids are stable and the NSE replaces them
by id.

### Revocation

- **Daemon revokes a device:** the existing ADR 0012 path removes the address,
  presence and queued deliveries and aborts in-flight requests. The daemon also sends
  a best-effort `DELETE` for the device's handles and stops its Live Activity updates.
- **Phone unpairs or turns off notifications:** the app deletes its handles, deletes
  the Keychain key and auth secret, ends its activities and unregisters with the
  daemon if connected.
- **App deleted:** APNs returns `Unregistered`, the gateway returns 410 and the daemon
  marks the address gone.
- **Gateway key compromise:** revoke the key in the developer portal, deploy the
  overlap key and close the old connections. Rotating the gateway's handle-sealing key
  invalidates every handle. Apps re-register on their next launch, and the daemon
  gets 404/410 until then.
- Pushes that Apple already accepted can't be recalled. Because they are ciphertext,
  a revoked phone that has already lost its key shows only the generic text.

## What the owner must set up or approve

1. **Approve the hosted exception:** amend ADR 0002 so ace may run a push gateway that
   sees device tokens, timing and ciphertext only. Approve the gateway's privacy
   statement and no-logging rules.
2. **Apple Developer Program** membership for the ace team ($99/year).
3. **Identifiers:** the app bundle id, plus NSE and widget extension bundle ids.
   Capabilities: Push Notifications, Time Sensitive Notifications, App Groups and a
   shared Keychain access group. Info.plist: `NSSupportsLiveActivities` and
   `NSSupportsLiveActivitiesFrequentUpdates`.
4. **APNs keys:** one sandbox and one production key, scoped to the ace topics. Hold
   the Key IDs and Team ID. Store the `.p8` files only in the gateway's secret store,
   never in the repo, the daemon or CI logs.
5. **Gateway hosting:** a provider and account for one small Node 24 container. A
   VPS-class instance is expected to cost about $5–10/month; APNs itself is free. Also
   a domain such as `push.<ace domain>` with TLS, plus monitoring and an on-call owner
   for key rotation. Cloudflare Workers is not assumed: APNs requires HTTP/2, and ace
   already has a tested `node:http2` client.
6. **Approve removing daemon-direct APNs** (`ACE_APNS_*` in
   `apps/daemon/src/notification-config.ts`). This is a breaking change for anyone
   using it.
7. **Approve the Live Activity privacy trade-off** (status and counts visible to
   Apple and the gateway, opt-in), or keep Live Activities out of the MVP.
8. **App Store privacy details:** declare the push token as data collected for app
   functionality, not tracking.
9. **Later, for Android:** a Firebase project and service account for the gateway.
   UnifiedPush is an alternative with no Google key at all.
10. **Optional:** apply for the notification filtering entitlement.

## Phased plan

Each phase is its own PR. No phase runs provider processes, spends subscription quota
or runs real-model evals.

**A. Daemon and protocol (no Apple account needed).**

- Phone delivery acknowledgment and foreground presence (fixes the router risk).
- `Urgency` and `Topic` headers on the Web Push transport.
- Auto-generated VAPID key and a default gateway origin on the allowlist.
- Additive `liveActivity.register` / `unregister` schemas.
- Correct the protocol's APNs token rule (see Contradictions).
- Tests: real WebSocket, temp SQLite, injected clock:
  - a suspended phone (open socket, no ack) falls through to push;
  - a foreground phone does not get a duplicate push;
  - a done → working race sends no done.

**B. Push gateway.**

- `apps/push-gateway` with sealed handles, VAPID binding, denylist, rate limits and a
  Docker image. Move the APNs HTTP/2 client into it.
- Tests: a real HTTP server and a local HTTP/2 fake APNs with a generated ES256 key
  verify JWT, headers, topic, push type, collapse id and the 4 KB limit.
  - `Unregistered` maps to 410.
  - Rotating the VAPID key is rejected.
  - A denylisted handle returns 404.
  - Oversized and malformed bodies are rejected.
  - Live Activity `content-state` that doesn't match the schema is rejected.
  - Logs contain no token or handle; a test greps captured logs.
- Mutation testing as in ADR 0012.

**C. iOS alerts.**

- Registration flow, Keychain group, NSE decrypt and content, categories, background
  action send through the SDK outbox, and cleanup of stale delivered notifications.
- Tests:
  - Swift unit tests decrypt the RFC 8291 vector and a Node-produced vector, and fail
    closed on tampering;
  - simulator `xcrun simctl push` checks NSE content and the generic fallback;
  - a fake daemon checks that an action resolves the exact option id once, and that an
    offline action stays pending.
- Owner-run, manual: one real-device sandbox push through a staging gateway with the
  sandbox key.

**D. Live Activity.**

- Widget extension, follow and unfollow, daemon scheduler and Live Activity
  transport.
- Tests:
  - a pure scheduler table: transitions, coalescing, heartbeat, stale date, quiet
    hours, the 7 h 50 m end, and no end while any child works or an interaction is
    pending;
  - fake-APNs assertions on priorities and rate;
  - simulator Live Activity rendering for every state, including stale.

**E. Production.**

- Deploy the official gateway and add the App Store / TestFlight entitlements.
- Remove `ACE_APNS_*` from the daemon. Update ADR 0012 and the notify README.

**F. Android (follow-on).**

- See below.

## Android follow-on (FCM)

The same gateway gets an FCM egress. The FCM HTTP v1 service account lives only on the
gateway (ADR 0073).

- The phone registers its FCM token for a handle exactly as on iOS. The daemon is
  unchanged: it still sends RFC 8291 Web Push to the gateway.
- The gateway sends a high-priority **data-only** message with the ciphertext. Android
  wakes the app's `FirebaseMessagingService`, which decrypts and posts the
  notification itself. No NSE equivalent is needed. FCM limits data payloads to
  4 KB, the same budget as APNs.
- Actions use notification actions that start the same pinned-WSS `interaction.resolve`
  path, with `setAuthenticationRequired` where supported.
- There is no Live Activity on Android. The equivalent is an ongoing,
  progress-style notification that the app updates from data messages. It uses the
  same pure scheduler and the same whole-tree rules. Check the current Android
  progress-notification API before building it.
- **UnifiedPush** endpoints are plain Web Push endpoints. The daemon can send to them
  directly, with no gateway and no Google key. Offer this for de-Googled phones.
- Needs a separate short ADR (ADR 0073 requires one) and the owner's Firebase setup.

## Contradictions found

1. **Daemon holds an APNs key today.** `apps/daemon/src/notification-config.ts` loads
   `ACE_APNS_KEY_FILE` (.p8) into `createApnsTransport`. This conflicts with #560 ("never
   ships signing keys in the daemon") and the spirit of ADR 0073. ADR 0012 accepts it as
   "direct opt-in APNs".
2. **That direct APNs payload isn't "privacy-safe title/status" only.** `apns.ts` sends
   the full `Notification` as plaintext under `ace`. That includes thread id,
   interaction id, option ids and, with preview consent, `preview` and `message`, along
   with the title as alert text. ADR 0012 describes it as exposing only title and
   status.
3. **ADR 0012's relay endpoint is unbuilt, and its operator is unclear.** ADR 0012
   describes `POST /v1/hosts/{hostId}/notifications` with host credentials, and says
   "FCM service-account credentials belong to the relay operator". ADR 0070 and
   `docs/daemon/remote-access.md` say the relay is self-hosted and "ace operates no
   hosted service". `apps/relay` is only a WebSocket rendezvous for Noise channels,
   with no push endpoint. A self-hosted relay can never push to the App Store build.
   This draft replaces the host-scoped design with a host-blind gateway.
4. **The APNs token schema hardcodes the length.** `protocol/notifications.ts` requires
   `^[a-fA-F0-9]{64}$`, but Apple says
   "[APNs device tokens are of variable length. Do not hard-code their size.](<https://developer.apple.com/documentation/uikit/uiapplicationdelegate/application(_:didregisterforremotenotificationswithdevicetoken:)>)"
   (Under this design the daemon no longer sees APNs tokens. Relax or retire the rule.)
5. **Router websocket-first delivery can lose phone alerts.** The router returns
   `accepted` whenever the device has a socket. A suspended iPhone can keep one open, so
   the push is skipped and nothing is shown. Phase A fixes this.
6. **Live Activities can't meet ADR 0012's "relay cannot read" promise.** iOS decodes
   `content-state` itself, so status and counts are visible to Apple and the gateway.
   This must be disclosed and opt-in, or Live Activities dropped.
7. **Quiet hours drop needs-you alerts permanently.** ADR 0012 says suppressed alerts
   "are not held for later delivery". This doesn't violate a constraint, but an
   approval raised during quiet hours never alerts. Consider one summary alert when
   quiet hours end. Owner's call.
