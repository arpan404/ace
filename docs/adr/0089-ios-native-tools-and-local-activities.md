# 0089: Native iOS services and local Live Activities

Date: 2026-10-19. Status: implemented. Extends [ADR 0074](0074-native-ios-client.md).
Local Live Activities extend the scope of [ADR 0087](0087-ios-local-notifications.md);
the remote push proposal remains deferred.

## Decision

Native settings and thread tools use the selected machine's existing `ClientCore`.
The JavaScriptCore bridge allows a fixed set of schema-validated service requests.
It limits concurrent requests to 32. Native tasks can cancel requests, and runtime
replacement cancels outstanding native waiters. Thread mutations, including branches, continue
through the durable command outbox. Daemon authorization remains authoritative.
Provider API-key submission is excluded from this bridge.

Terminal output has one native stream at a time. Native delivery returns credit
with the acknowledged byte offset. Reconnect resumes from that offset; an output
gap resets escape parsing before rendering the gap marker and replay. The renderer
bounds scrollback to 1,000 rows of 80 cells. It supports basic text controls rather
than a complete terminal emulator. Browser controls use still screenshots; live
frames and screen/device control remain future work.

Published HTML uses the shared `@ace/html` sandbox in a nonpersistent WKWebView.
The viewer has no native message handlers. Published images use authenticated
thread attachments and native decoding.

The app owns palette preferences. Generated token adapters observe the registered
palette and preserve view identity when colours change. Semantic status and diff
colours remain fixed. Widget extensions keep the shared token defaults.

The person can start a local ActivityKit activity for a thread. Its identity
includes the paired host and thread. Only a canonical whole-tree Done row confirmed
by the current connection and inbox subscription can end it. Reconnect invalidates
cached confirmation; welcome alone cannot turn a cached Done row into completion.
A newer row or disconnect also revokes a queued activity ending. Foreground reconciliation renews unchanged content every 30 seconds from
the persistent navigation stack. Content becomes stale after 60 seconds without
renewal; offline and stale labels ask the person to reopen ace. No APNs token,
gateway, background-delivery promise or provider credential is added.

## Verification and limits

The [simulator progress record](../verification/ios-emulator-parity/README.md) records
executed checks. Simulator results do not establish physical-device rendering,
input latency, background delivery, Tailscale pairing or TestFlight distribution.
Those gates remain open.
