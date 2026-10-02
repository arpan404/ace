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

Selectors declare change keys, such as an item id or thread metadata, and expose stable `getSnapshot` and `subscribe` functions compatible with useSyncExternalStore. Copy only changed entities before the projection mutates them; never copy the full transcript for a delta. Route notifications through keyed listener sets. Bound cached scopes with LRU eviction of unreferenced views, item windows, frames, pending requests, selectors and durable intents. Reject excess active subscriptions instead of evicting live views.

## Protocol additions

Keep v1 hello, subscriptions, commands and receipts intact. Add a separate schema module for correlated `request` and `response` messages. The request union initially contains `items.page{threadId,before,limit}` and `output.read{threadId,itemId,offset,limit}`. Pages return item cursors and at most 200 items; output reads return at most 256 KiB. Responses carry requestId and either a parsed result or a typed error code. Add optional `itemsBefore` to thread snapshots.

The current daemon stores legacy shell output in items. Until ADR 0006 stream storage lands, reads slice that stored output and identify it by thread/item rather than streamId. This compatibility implementation does not claim bounded daemon history reconstruction. The SDK itself never accumulates complete output. Snapshot delivery is windowed; future stream storage can add another request variant without changing the transport.

## Security

Credentials are requested for each connection and only sent in hello. Never persist or log tokens. Device identity is fixed for the persisted outbox; reject stored commands for another device. Storage is host/device scoped by the caller, who must not reuse it with another daemon. Validate every frame and persisted record with Zod before using it. Enforce frame size and queue caps before parsing. Treat authentication errors and close codes 4001 and 4003 as fatal. Secure remote transport and pairing stay with the remote-access and relay packages.

## Performance

Delta application and entity notification work is proportional to changed entities and their subscribers. LRU ordering uses Map insertion order. Persisting the outbox rewrites a bounded list only on intent transitions, outside the stream hot path. Bound live item windows and text per item; text overflow trims to half the cap and sets an explicit truncation indicator in the SDK. This amortizes tail copying across subsequent appends. Benchmarks report event application, selector fan-out, throughput and RSS without gating tests on timing.

## Verification

Use a real in-process daemon on an ephemeral port, temp SQLite and a transport wrapper that drops, duplicates, reorders and disconnects frames. Assert public selected values and command effects. Inject a manual scheduler for deadlines and reconnects; synchronize socket work with observable state, never sleeps. Cover exact resume, snapshot resync, durable replay exactly once, request timeout/abort, subscription references, LRU, heartbeat and fatal auth. Apply at least eight production mutations and require the relevant behavior test to fail for each before reverting. Run the full local check before opening the PR.

## Integration with remote access

Remote access landed in main during implementation and was merged. Local hello uses the local token; paired devices exchange their device token over authenticated HTTP for a fresh single-use socket ticket on each attempt. The credential provider can return either form. The SDK's ticketCredential helper parses the exchange response while the caller owns HTTP and pinned TLS. Tokens and tickets never enter the outbox. New read requests require read scope, just like subscriptions. Device revocation is fatal. Daemon identity must stay the same across reconnects.

The first-answer-wins integration test uses a synchronous CommandHandler with real receipt transactions and interaction events. Production arbitration still belongs to the engine from ADR 0007; the current daemon development handler does not implement interaction resolution. Large-payload storage and indexed item paging from ADR 0006 remain separate daemon work. The compatibility read handler reconstructs a legacy view and searches its order; this is bounded on the wire, but its daemon cost still grows with history. Items larger than the page byte budget fail explicitly. This is the main performance limitation pending that work.
