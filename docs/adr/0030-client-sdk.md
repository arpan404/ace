# 0030: Shared typed daemon client

Date: 2026-10-02. Status: accepted.

## Context

Desktop, web and Expo need the same reconnect, replay and durable-command behavior. Putting it in each UI would create three versions of correctness. The competitor inventories in `/tmp/ace-orch/research-t3code.md` and `/tmp/ace-orch/research-competitors.md` describe remote control, approvals and live transcripts in t3code, Codex, Claude Code and Cursor. Those inventories do not establish exact replay or offline command guarantees. We need to test our own guarantees. No competitor implementation is used.

ADRs 0004 and 0007 make the daemon responsible for tree status and first-answer-wins. The SDK displays daemon facts, never guesses that a disconnected agent finished. ADR 0006 requires bounded history and lazy output reads.

## Decision

Add `@ace/client`, a headless package with no Node runtime imports. Inject transport factories, credentials, durable storage, scheduler and randomness/id generation. A WebSocket adapter accepts a browser/React Native compatible socket factory. Relay and LAN TLS can supply the same transport interface later.

The connection transitions through connecting, ready, reconnecting, offline and fatal. Each attempt has an epoch so late callbacks cannot revive a dead connection. Hello and heartbeat deadlines detect silent sockets. Retry uses capped exponential backoff with full jitter; an online hint retries immediately. Authentication rejection is fatal and requires a new client with corrected credentials.

Requests have bounded correlation maps, deadlines and AbortSignal cancellation. Cancellation removes the local waiter; it cannot undo a command already accepted by the daemon. Durable intents use Command.id as their idempotency key. Serialize persistence before sending, retain pending commands across crashes, and persist acknowledgements before marking an intent acked or failed. A timeout or disconnect leaves the durable intent pending. The daemon owns cross-device interaction arbitration.

Subscriptions share one wire subscription per scope. Each cached view owns its last applied host cursor. Resume only from that cursor. Duplicate coverage is ignored; missing or overlapping coverage triggers a fresh snapshot with a new subscription id, invalidating stale in-flight frames. Reordering can cause a conservative snapshot resync. Do not infer gaps from filtered event sequence numbers. Use `@ace/projection.applyDelivery` for the actual fold.

Selectors declare change keys, such as an item id or thread metadata, and expose stable `getSnapshot` and `subscribe` functions compatible with useSyncExternalStore. Copy only changed entities before the projection mutates them; never copy the full transcript for a delta. Message deltas pass a copied tail through projection.applyDelta and share the immutable prefix; a lazy parts getter materializes the array only when read, without retaining a chain of previous messages. Route notifications through keyed listener sets. Bound cached scopes with LRU eviction of unreferenced views, item windows, frames, pending requests, selectors and durable intents. Reject excess active subscriptions instead of evicting live views.

## Protocol additions

Keep v1 hello, subscriptions, commands and receipts intact. Use ADR 0006's native correlated `items.page` and `output.read` requests. Snapshots/pages also carry an optional itemSeqs record containing each loaded item's creation sequence. This lets a smaller SDK window and subsequent live evictions retain the correct older-history cursor without a log search. Pages use an exclusive numeric creation-sequence cursor, return at most 200 items, and now include an additive `seq` consistency cursor. Output reads identify a stream, use byte offsets, and return base64 bytes in chunks of at most 256 KiB. The SDK validates correlation scope, result type, offsets and decoded length, then exposes Uint8Array chunks. It fetches the next chunk only when its async-generator consumer advances.

Add optional requestId/subscriptionId to daemon error frames. Recoverable failures affect that request or subscription; auth and wire corruption remain connection failures. Thread snapshots contain bounded summaries and a numeric itemsBefore cursor. A subscription accepts its initial snapshot once; resumed delivery or an accepted snapshot closes that acceptance window. Stale duplicates cannot move a cursor backwards.

Maintain a per-thread item-change journal capped by event count and bytes. Before a history page enters the store, replay later updates/deltas affecting that page's items. Hydrated item watermarks suppress live deltas already included in a newer page. If journal eviction or a snapshot removes required coverage, reject admission with ClientError("stale") and require a fresh read. Paging never advances the subscription cursor.

## Security

Credentials are requested for each connection and only sent in hello. Never persist or log tokens. Device identity is fixed for the persisted outbox; reject stored commands for another device. Storage is host/device scoped by the caller, who must not reuse it with another daemon. Validate every frame and persisted record with Zod before using it. Enforce frame size and queue caps before parsing. Treat authentication errors and close codes 4001 and 4003 as fatal. Secure remote transport and pairing stay with the remote-access and relay packages.

## Performance

Delta application and entity notification work is proportional to changed entities and their subscribers. LRU ordering uses Map insertion order. Persisting the outbox rewrites a bounded list only on intent transitions, outside the stream hot path. Bound live item windows and text per item; text overflow trims to half the cap and sets an explicit truncation indicator in the SDK. This amortizes tail copying across subsequent appends. Benchmarks report event application, selector fan-out, throughput and RSS without gating tests on timing.

## Verification

Use a real in-process daemon on an ephemeral port, temp SQLite and a transport wrapper that drops, duplicates, reorders and disconnects frames. Assert public selected values and command effects. Inject a manual scheduler for deadlines and reconnects; synchronize socket work with observable state, never sleeps. Cover exact resume, snapshot resync, durable replay exactly once, request timeout/abort, subscription references, LRU, heartbeat and fatal auth. Write regression tests for each review fix and list the production mutations they are designed to detect. The owner now requires tests to run once at merge: do not execute tests, probes, mutation runs, benchmarks or the combined check during feature work. Use formatting, lint, size and type checks as the local gate. Final behavior and mutation verification needs run at merge; preserve earlier benchmark measurements with their revision limits.

## Integration with remote access

Remote access landed in main during implementation and was merged. Local hello uses the local token; paired devices exchange their device token over authenticated HTTP for a fresh single-use socket ticket on each attempt. The credential provider can return either form. The SDK's ticketCredential helper parses the exchange response while the caller owns HTTP and pinned TLS. Tokens and tickets never enter the outbox. New read requests require read scope, just like subscriptions. Device revocation is fatal. Daemon identity must stay the same across reconnects.

The SDK integration now uses the daemon's production development CommandHandler for concurrent answers. Its indexed interaction lookup and closure run inside the existing command receipt transaction, so one answer closes the interaction and the other receives already_resolved. Actual provider delivery remains the engine's responsibility; this test sends no provider prompts. Clock input for these command facts is injectable.

The SDK consumes the large-payload work from PR #12 rather than implementing a second storage owner. Remove the original compatibility request/response schemas and history-reconstructing reads. Indexed pages and stream chunks own cold reads; snapshots are constructed only when replay cannot be used. Preserve the shared protocol's validated opaque keys (including `__proto__`) with own-property writes.

Parent indexes discard empty historical entries; snapshot budgets include parent keys and child references. Exceeding a scope's entity budget reports a scoped limit error while preserving its existing work facts. The client never evicts active agent facts to make a tree appear settled. Benchmarks include single/multipart deltas, keyed fan-out, repeated reparenting, and cold output reads at different history sizes.

## History admission and bounded text details

Merge history windows by each item's creation sequence, keeping the oldest contiguous retained window under the item cap. Arrival order and duplicate page responses cannot reorder items or replace a proven end-of-history cursor. A legacy page missing required creation cursors rejects with a typed stale error instead of guessing an order.

Wire pages have a 1 MiB response budget. Message, reasoning and notice text use previews totaling at most 4,096 code units per item, with optional source descriptors containing streamId, bytes and encoding. Full text is available through the existing scoped output.read port. The SDK text(source) generator reads exactly the descriptor's byte count and yields decoded strings lazily. Text sources store UTF-16LE code units in chunks of at most 64 KiB, preserving surrogate pairs split between provider deltas. Sources use a separate indexed table under the existing payload owner; their IDs include the authoritative revision. Replacement deletes old sources, so an interrupted detail read fails explicitly instead of combining two versions. Append-only growth preserves the source ID.

Text appends write only their new bytes and one size counter, reusing prepared statements. They never parse, scan or rewrite the previous multipart preview. Preview materialization occurs on explicit page reads. Startup upgrades existing items and indexed text chunks once, retaining one row or chunk at a time. This adds an indexed copy of text to support bounded detail reads; it does not rewrite the full item per delta. Oversized non-text metadata that cannot fit a page produces a correlated read error rather than an oversized frame.

New shell output writes use bounded chunks of at most 64 KiB without allocating a Buffer for an entire append. Output ranges slice intersecting blobs in SQLite before transfer to JavaScript, including legacy multi-megabyte chunks. The range query seeks the predecessor and returns only the requested bytes. Merge-time benchmarks cover one-byte reads inside 1/16 MiB single blobs and persistence into 1/200-part messages. These new paths have not been benchmarked under the owner's no-execution rule; their throughput and RSS need run at merge.
