# @ace/notify

Backend notifications for canonical thread status, approvals/questions and background completion. The daemon's default startup creates a private `notifications.sqlite` next to the event log. Clients receive `notification` websocket messages and show native/browser notifications themselves.

## API

- `NotificationService` is the synchronous SQLite shell for deterministic tests or an owner already running off the event loop. Inject `now`, `jitter` and `NotificationTransport`. Ingest parsed canonical `Event` batches, then call `drain` when time advances. `cursor` survives restart. `register`, `preferences`, `snooze`, `updatePresence`, `disconnect`, `revoke` and `close` own policy and lifecycle.
- `NotificationWorker` runs that shell in a Node worker. The daemon uses this API. Methods return promises. Ingestion admits up to 256 events per call and copies only bounded metadata, never deltas, prompts or raw provider data. Each frame is capped at 128 KiB; at most 8 MiB and 64 RPCs are outstanding, along with 16 deliveries. The optional `spawn` boundary supports real-worker instrumentation. Oversized routing ids are skipped with sequence coverage so they cannot poison replay. Rejected log batches recover through replay.
- `attachNotifications` connects either consumer to `readEvents`/`subscribe`. Call `tick` at most once a second; overlapping ticks share work. Each tick reads at most sixteen pages. Delivery waits until replay has caught up, so a historical done state cannot escape ahead of a later working state. Stop subscription before closing the service.
- `createNotificationRouter` sends to connected websocket clients, then falls back to the device's registered Web Push/APNs/FCM transport. `NotificationTransport.send` must observe its abort signal and return `accepted`, `retry`, `gone` or `failed`. `gone` revokes the address; `retry` uses bounded exponential backoff with jitter. Vendor acceptance can be duplicated after a crash; clients replace notifications by id.
- `createWebPushTransport` accepts a P-256 PEM private key, VAPID contact subject and an explicit HTTPS origin allowlist. `encryptWebPush` exposes the RFC 8291 record encoder for conformance testing. VAPID and ECDH keys are separate.
- `createApnsTransport` accepts `{ teamId, keyId, topic, privateKey, endpoint? }`. `privateKey` is the content of the `.p8` file. The endpoint defaults to production; sandbox is supported. Call `close` when the owner shuts down. The third argument injects an HTTP/2 connection for tests.

The standard daemon exposes `daemon.notifications.revoke(deviceId)` for the device authority. It accepts optional transport overrides as `startDaemon(config, handler, toolkits, channels)`. Injected transports remain owned by their caller. Local authentication still uses the existing host token. Remote tickets bind paired device identity and scopes. Read scope permits notification delivery, registration, preferences and presence; operate scope is required for thread snooze and approval commands. Remote revocation removes socket recipients and revokes notification addresses, and each delivery rechecks the persisted device authority.

## Configuration

The daemon loads optional channels at startup using these environment variables:

| Channel  | Variables                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| APNs     | `ACE_APNS_KEY_FILE`, `ACE_APNS_TEAM_ID`, `ACE_APNS_KEY_ID`, `ACE_APNS_TOPIC`, optional `ACE_APNS_ENDPOINT` with Apple's production or sandbox URL |
| Web Push | `ACE_VAPID_KEY_FILE`, `ACE_VAPID_SUBJECT`, `ACE_WEB_PUSH_ORIGINS` containing a JSON array of HTTPS origins                                        |

Missing channel configuration leaves websocket delivery enabled. Signing keys are read asynchronously once at startup and are never sent to clients. Generate VAPID P-256 keys independently of APNs keys. Do not put signing keys into the repository.

## Client contract

After an authenticated hello, register the notification address with `notification.register`. Identity always comes from the connection. Send `presence.update` on focus/input changes and every 30 seconds while focused, with a thread id or null and the age in milliseconds of the last human input. Send `notification.preferences` for quiet hours or preview consent and `notification.snooze` for a thread deadline. These messages produce an error on rejection; a subsequent pong is an ordering barrier.

Notification ids are stable, titles are capped at 200 characters, and payloads contain no code, question text, approval description or provider error. Previews require per-device consent and a supplied preview source; the default daemon has none. The `threadId` and optional `interactionId` are the deep link. Fixed approve/deny actions contain canonical option ids. Submit actions through the existing authenticated `command` envelope with `interaction.resolve`, a new command id and the authenticated device id. Fetch current interaction details before showing a sensitive approval. The engine owns validation and first-answer-wins behavior.

Phone push is discarded if another session is focused on this thread, its heartbeat is at most 60 seconds old and its last human input is at most 120 seconds old. Suppression, snooze, quiet hours, interaction validity and thread generation are rechecked on every attempt. Quiet hours are per-device and use an IANA timezone. Snoozes apply to the thread across devices. Suppressed alerts are not held for later delivery.

Limits are 128 devices including revocation tombstones, 256 presence sessions, 10,000 pending thread notifications, 10,000 queued deliveries and five send attempts. A full intent spool evicts its earliest-due alert when admitting a new thread, so replay always advances; thread and active interaction/task state are preserved. Delivery job capacity applies backpressure to fan-out. The compact thread index and tombstones live on disk; there is no transcript cache. Older projection versions rebuild from the event log while retaining devices and policy. Deep links share core's actionable-interaction rule, and closing an approval refreshes any remaining needs-you alert. Retries expire 24 hours after the originating event. Revocation aborts local requests; a push already accepted by a vendor cannot be recalled.

FCM and the encrypted relay are interfaces and endpoint designs in [ADR 0012](../../docs/adr/0012-notifications.md). This package implements direct APNs delivery, whose bounded title/status is visible to Apple. It does not implement mobile clients, service workers or an FCM relay.

## Verification

`bun run test packages/notify apps/daemon/src/notifications.server.test.ts` exercises core-derived alerts, real SQLite restart/replay, websocket authorization, RFC encryption, real HTTP delivery and a credential-free HTTP/2 APNs peer. `bun run --filter @ace/notify bench` measures ingestion, fan-out and indexed presence; `bun run --filter @ace/notify bench:backlog` measures overload, eligible-link lookup and giant unused metadata without gating CI on timing. See [mutation evidence](../../docs/notifications-mutations.md).
