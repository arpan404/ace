# 0012: Notifications across devices

Date: 2026-10-02. Status: accepted.

## Context

The supplied competitor inventories report browser notifications and badges in t3code, mobile delivery through its relay, remote notifications in Codex, presence suppression in Claude Remote Control, and PWA push in Antigravity. They do not establish whole-tree completion correctness or delivery recovery. These inventories are feature references only. No competitor implementation is used.

ace needs alerts for human interactions, completion, failure, silence and background completion. Provider turn-end signals cannot establish thread completion. ADR 0004 makes core's `thread.updated.status` events authoritative. `wake.expected` keeps a thread working during an anticipated self-started turn, so it must not generate a premature done alert.

## Decision

`@ace/notify` owns a separate SQLite database, an incremental event consumer, policy, delivery queue, Web Push and APNs transports. The daemon runs notification SQLite and policy in a Node worker to keep disk I/O off its socket and provider event loop. IPC uses a strict compact schema, excluding deltas, raw provider data and unused event/workspace/root-agent identifiers. Routing ids are validated before copying; unrepresentable ids are skipped with their replay coverage, rather than stranding the cursor. Each message is capped at 128 KiB, total outstanding RPC bytes at 8 MiB, and at most sixteen compact records enter a frame. A delta-only page sends only sequence coverage. The daemon supplies committed event batches and replay pages through a small port. Startup and periodic catch-up replay from a durable host-wide cursor alongside a live subscription. Delivery waits until catch-up reaches the current log. Cursor, compact thread state and pending notifications commit together. Transport acceptance and queue deletion cannot be atomic, so delivery is at least once. Stable notification ids let clients replace duplicates.

A fixed five-second window combines a thread's burst. The latest authoritative status replaces the pending status. Returning to work cancels stale completion or human-needed alerts. Background completions accumulate a count, without task output or task titles. An actionable interaction opening, closing or changing eligibility refreshes a needs-you alert even when the status remains needs-you. Deep links use the same exported eligibility predicate as core: blocking pending interactions always qualify; a nonblocking question qualifies only when its owning agent is not working. Agent status changes update only that agent's open interaction rows. An indexed eligible/sequence lookup chooses the first actionable link, and retries recheck eligibility. Replayed sequences and repeated terminal task updates do not notify twice.

Per-thread snooze and device quiet hours discard alerts at delivery time. Quiet hours use IANA time zones and local clock minutes, including overnight ranges; equal endpoints mean all day. Policy is checked again before retries. Phone delivery is suppressed if another authenticated session has the thread focused, a fresh heartbeat and recent human input. Presence expires after 60 seconds, input after 120 seconds, and disconnect removes it. Presence is indexed by thread and bounded by the session limit.

## Protocol and integration

Add schemas in `protocol/notifications.ts` and additive union members in `wire.ts`:

- `presence.update { threadId: string | null, inputAgeMs }`, attached to the authenticated connection identity. Clients send on focus/input and at least every 30 seconds while focused. Age is relative, avoiding client clock skew. The server stamps receipt time.
- `notification.register { device }`, with websocket, Web Push, APNs or FCM addressing. Identity comes from authentication, never the registration body.
- `notification.preferences { quietHours?, includePreview }` and `notification.snooze { threadId, until }`.
- Server `notification { notification }` contains a stable id, thread id, status, thread title, optional interaction id, background completion count and fixed approve/deny actions referencing canonical option ids. Notification contents never contain bearer tokens.

Actions use the existing authenticated `command` envelope with `interaction.resolve`. They require a fresh connection, device identity matching authentication, normal command receipts and the engine's first-answer-wins check. A notification grants no extra authority. Clients must fetch current interaction details before presenting sensitive approvals. Revocation removes addresses, presence and queued delivery and aborts in-flight requests where possible; already accepted vendor pushes cannot be recalled.

The daemon gets an optional notification port for registration, presence, preferences and a websocket delivery callback. Its standard startup creates the local notification service. Remote device authentication/revocation will plug into the port from `feat/remote-access` when merged. The relay and FCM implementation are separate workstreams; this package exports a mobile transport interface and has no provider credentials.

## Web Push and mobile delivery

Web Push uses [RFC 8030](https://www.rfc-editor.org/rfc/rfc8030), [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291) and [RFC 8292](https://www.rfc-editor.org/rfc/rfc8292). Node crypto generates ephemeral P-256 ECDH keys and salt, derives HKDF-SHA256 keys and nonce, and encrypts one bounded aes128gcm record. VAPID uses a separate P-256 signing key, origin audience and expiry under 24 hours. Endpoints must match an operator-supplied HTTPS origin allowlist; redirects are rejected. Subscription secrets stay in the private local database.

APNs is enabled only with a team id, key id, topic and `.p8` signing key. A bounded HTTP/2 client signs ES256 provider tokens and sends alerts to `/3/device/{token}` with topic, push type, expiry and collapse id. See [Apple token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns). Tests substitute a local HTTP/2 server and generated signing key. FCM has the same `send(device, notification, signal)` interface; service-account credentials belong to the relay operator, never provider login.

Relay endpoint design: `POST /v1/hosts/{hostId}/notifications`, authenticated with a paired host's scoped relay credential. Accept a bounded request id, target device id, expiry, collapse id and opaque device-encrypted payload. Validate host-device ownership, revocation and rate limits before enqueueing. APNs/FCM receive a generic wake alert with encrypted data for a notification service extension or client fetch. The relay cannot read thread titles, interactions or code. Response statuses are accepted, revoked, retryable or permanent failure. Deduplicate request ids with TTL; keep bounded queues and exponential retry. Approval actions go over the authenticated end-to-end daemon command channel, never through the push endpoint. The direct opt-in APNs transport here exposes the privacy-safe title/status to Apple; it is not the encrypted relay transport.

## Security and privacy

Default content contains only a bounded title and status, plus opaque navigation ids. Question text, approval descriptions, error messages, code and prompts are excluded. An explicit per-device preview preference permits a bounded caller-supplied preview in deployments that wire a preview source. The standard daemon has no preview source. Registrations and settings require an authenticated websocket. Revoked devices cannot register themselves again until the device authority restores them. Private daemon directory permissions protect the database and signing configuration. Never log push endpoints, secrets or JWTs.

## Performance and limits

Events do constant work per changed entity using prepared SQL and compact per-thread indexes. Deltas are skipped without walking transcript history. Replay uses pages. Due work uses indexed deadlines and fixed batch limits, rather than scanning history. Cap devices, sessions, pending notifications and delivery jobs. Active interactions and tasks live in indexed SQLite rows, so even large trees do not grow in-memory sets. The disk intent spool holds at most 10,000 thread rows. Admission at that limit evicts the earliest-due alert intent and advances the cursor atomically; it never evicts thread state, interactions or live tasks. This explicitly prefers recent alerts under sustained overload to a replay deadlock. A transactionally maintained queue counter avoids counting the spool on each event. Delivery jobs have a separate 10,000-row cap and backpressure; expired or empty intents are pruned before fan-out. Only fixed-size payloads enter transport buffers. Retry count, request duration, response size and concurrency are bounded. Device websocket recipients are indexed by device id; fan-out visits only that device's connections. VAPID tokens are cached per allowed origin and APNs tokens rotate before expiry. Terminal delivery rows are deleted; thread state and snoozes live on disk, not in a process-wide cache.

A schema-version upgrade rebuilds the older notification projection from the event log, preserving devices, revocation tombstones, preferences and snoozes. Replay gates delivery during the rebuild; at-least-once replacement still applies. After asynchronous authentication, a websocket must remain open and own its cleanup registration before entering the recipient index.

Non-gating benchmarks measure ingestion, burst fan-out, backlog admission/draining, owner eligibility changes, oversized metadata and presence lookup with throughput and peak RSS. No provider process runs during testing.

## Verification

Test public behavior using core facts and events, temporary SQLite, real websocket/HTTP/HTTP2 servers, injected time and generated keys. Cover whole-tree status and wake grace, every alert kind, duplicate replay, burst replacement, background completion, snooze/quiet hours including DST, presence expiry/disconnect, authenticated actions, restart recovery, transient backoff, terminal failures and revocation. Match the complete RFC 8291 example ciphertext, not just round-trip encryption. Verify JWT signatures and request headers against the local servers. Apply at least eight meaningful production mutations, observe failures, revert them, and record results in the PR.
