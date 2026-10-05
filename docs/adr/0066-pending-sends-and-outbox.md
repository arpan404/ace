# 0066: Pending sends and durable client intents

Date: 2026-10-04. Status: accepted.

## Context

A send must appear when Enter is pressed, including its text, images and execution picks. Saving
locally, waiting for a daemon receipt and being admitted to a transcript are distinct states.
A disconnected durable waiter must not report failure while its command remains replayable.
Retaining every accepted payload eventually exhausts the client outbox, particularly when no
transcript lease is open. Dedicated browser workers also need to persist independent records
without overwriting each other's sends.

## Decision

`ClientApi.pendingSends(threadId?)` supplies saving, sent, accepted, delivered and failed entries.
`intent(commandId)` supplies the corresponding durable intent. Both APIs keep their existing
shapes; `usePendingSends` and `useIntent` consume them. Create commands retain their original
`pending:<commandId>` route after the receipt provides a real thread ID. The command ID is also
the queue entry ID and the admission item ID is `input:<commandId>`.

Byte and entry limits are checked before publishing a full draft. A storage write completes
before a command can reach the socket. Saving drafts consume the same memory budget as pending
work, but are excluded from aggregate persistence until their own write succeeds. Failed local
writes retain at most the newest 64 drafts, further restricted by the configured byte and entry
limits. Pending work is protected from eviction; settled cache entries can be evicted.

The daemon admission transaction, defined in ADR 0065, owns durable input after a successful
receipt. The client immediately deletes that command's persisted payload. This does not depend
on a thread lease, the 200-item transcript window or a later reload. Observing a correlated user
item through snapshots, live events, item pages or item windows marks the bubble delivered.
A delivery-failure notice carries `commandId` and changes the retained draft to failed, including
when the notice precedes the receipt. It does not replay automatically.

`idbOutbox(key, seed?, factory?)` stores individual records in `ace-intents`, scoped by daemon and
device. Writes and deletes affect only the named command, so independent workers cannot replace
each other's whole outbox. A transaction migrates the legacy aggregate once per scope and records
a marker alongside the rows. A compound-key prefix range includes every string command ID,
including IDs beyond U+FFFF. This supersedes ADR 0056's aggregate-storage decision. Product boot
must select this adapter; the Claude web agent owns that UI integration.

Durable commands have no failure deadline and keep waiting across reconnects. After five seconds
they expose a waiting hint. One-shot reads are never persisted or replayed. Read cursors use a
separate ephemeral coalescing channel, retry on reconnect, and retain the highest live waiter.

A tab allocates IDs with its injected generator. If none is supplied, the worker assigns a prefix
using the worker client's injected generator, and the tab appends a monotonic sequence. There is
no ambient randomness in runtime decision logic.

The worker exposes changed pending-send IDs. Each tab coalesces those IDs into one notification
per display frame; it reads only changed entries. Hidden tabs retain at most 256 dirty IDs, then
request one bounded reset when visible. They retain no extra payload copies in the backlog.
Tabs keep the removal channel attached for their entire lifetime, even without UI subscribers.
Tab caches bound both `command` and `enqueue` sends by 256 entries and 8 MiB; when nobody watches
pending sends they keep at most the newest 64 settled drafts. An active watcher permits up to the
same overall bounds. Closing the tab releases these caches.

## Consequences

Full drafts can disappear from the settled cache before a late UI subscription; admitted inputs
remain durable in the daemon transcript. Concurrent dedicated workers preserve distinct IDs,
although shared-worker coordination is still needed for instantaneous cross-tab state. UI code
must use stable draft IDs and interpret offline as pending, rather than encouraging duplicate
submissions. Retry and edit renderers, boot wiring and audit screenshot capture remain owned by
the Claude web agent.

Timing, browser-memory and behavioral confirmation of the review corrections need run at merge.
The owner forbids executing tests and benchmarks during this implementation run.
