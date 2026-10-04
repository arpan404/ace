# @ace/client

One headless daemon SDK for Electron renderers, browsers and React Native. Runtime code imports no Node built-ins. Inject credentials, storage, socket creation, timers, randomness and ids. Callers own one client and one storage namespace per daemon/device. Only one active client may write that namespace at a time. Storage.save must atomically replace the previous value before resolving.

```ts
import { Client, webSocketTransport } from "@ace/client";
import { DeviceId } from "@ace/protocol";

const client = new Client({
  deviceId: DeviceId.parse(deviceId),
  transport: () => webSocketTransport(() => new WebSocket(daemonUrl)),
  credential: () => secureStorage.readDeviceToken(),
  storage: outboxStorage,
  scheduler: {
    set(ms, callback) {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
  },
  random: () => Math.random(),
  id: () => crypto.randomUUID(),
});
await client.start();
const thread = client.thread(threadId);
const title = thread.store.select(["thread"], (reader) => reader.thread?.title);
const item = thread.store.select([`item:${itemId}`], (reader) => reader.item(itemId));
const stop = item.subscribe(() => render(item.getSnapshot()));
// React: useSyncExternalStore(item.subscribe, item.getSnapshot, item.getSnapshot).
// Keep the Selection stable between renders. Keys must include everything read.
stop();
thread.release();
await client.close();
```

`start()` loads the outbox and initiates connection. Observe `connectionState()` for readiness. `networkOnline(false/true)` cancels a dead connection and immediately retries after connectivity returns. Authentication rejection and device revocation are fatal; create a new client after correcting credentials. `close()` cancels networking immediately and resolves after already admitted persistence writes finish. Await it before handing the storage namespace to a replacement client. Durable intents remain available to that replacement.

`threads()` shares the sidebar subscription. `thread(id)` shares one subscription across views and retains inactive views in a bounded LRU. Release subscriptions and selector listeners when their UI owner unmounts. Selected objects are SDK-owned values; do not mutate them. Previously selected entities remain stable across future updates. A selector can read entities, their bounded order, cursor, history cursor and truncation flags. Selectors returning a new object should supply an equality function.

`enqueue(payload, id?)` durably records an intent before sending. Use stable globally unique ids for retry keys. `intent(id)` selects pending, acked or failed state, including daemon rejection text. Acked means the daemon accepted the command, not that an agent finished its work. Terminal receipts leave the bounded local cache as new intents arrive. Retry keys still work through the daemon's receipt store.

`command(payload, options?, id?)` adds a cancellable, timed waiter for the daemon receipt. Aborting or timing out a waiter cannot undo the durable intent or daemon effects. Use `enqueue` for offline sends. A reconnect replays pending intents even if a prior waiter was cancelled. A failed persistence write does not send anything. Persistence failures while recording receipts put the client in fatal state and keep the durable command replayable.

`itemsPage({threadId,before?,limit}, options?)` returns older items with an exclusive numeric creation-sequence cursor and consistency sequence. Use `thread.store.itemsBefore` as the older-page cursor. Creation-sequence metadata keeps this cursor accurate when the SDK trims a daemon window. Apply it with `thread.store.page(page)`. The store reconciles later item changes and rejects expired coverage with ClientError("stale"); obtain a fresh page in that case. Live creation advances the bounded window; updates to unloaded history do not reinsert it. `outputRead({streamId,offset,limit})` reads a bounded Uint8Array at byte offsets. `output` is an async generator that requests another chunk only when its consumer advances. Shell items expose bounded output summaries containing streamId, byte count and a tail; complete output lives in the daemon stream store.

Limits cover frame bytes, outgoing bytes, outbox bytes, concurrent persistence operations, intents, requests, cached threads, items, entity counts, item text and listeners. Text trims to half its capacity on overflow to amortize copying and reports `truncated(id)`. Non-item entity limits fail explicitly rather than dropping facts needed for tree status. The SDK processes each frame synchronously and retains no receive queue. Unordered or missing coverage conservatively resyncs from a snapshot with a new subscription id. All scope cursors remain host-wide, including filtered progress.

Run `bun run --filter @ace/client bench` for event application and notification fan-out measurements. Tests use real daemon sockets and SQLite; injected time controls deadlines without sleeps.

Remote access uses `credential: ticketCredential(readDeviceToken, exchangeTicket)`. The injected exchange sends the token in an Authorization header to `/v1/tickets` over pinned TLS and returns the bounded JSON response. The helper validates SocketTicket, and reconnects obtain a fresh ticket. Return ClientError("offline") for transient network failures and ClientError("auth") for rejected credentials. The token string shorthand in the example is for local connections.

Scoped failures are observable through thread/sidebar `error` selectors. Release and reacquire the scope to retry it. Other scopes and reads stay usable. Auth rejection and malformed/oversized frames remain fatal connection errors.

Large history text arrives as a bounded prefix with a source descriptor. Read its full text lazily, with no Node runtime dependency:

```ts
const item = page.items[0];
if (item?.type === "message") {
  const part = item.parts[0];
  if (part?.type === "text" && part.source) {
    for await (const text of client.text(part.source, { signal })) {
      // Consume the chunk before advancing. The SDK does not accumulate full text.
    }
  }
}
```

`text(source)` reads the byte length captured by that descriptor and preserves surrogate pairs between chunks. An authoritative replacement invalidates the old source; obtain a fresh page after its typed daemon error. Append-only text retains the source ID. `store.truncated(id)` reports when a loaded item contains a prefix rather than its full text. Overlapping pages merge by creation cursor, preserving order and the known end of history under the window cap.

UI code depends on `ClientApi` (with `ThreadSource` and `SidebarSource` stores), which `Client` implements in-process and `@ace/client-worker`'s `RemoteClient` implements in a tab whose client runs in a worker. `loadOlder(threadId, limit)` fetches and merges the page before a leased thread's window in one call. Stores expose `observe(tap)` (every emitted key, or `"all"` after a snapshot) and `export()` so a worker can mirror them into tabs.

## Long threads

`ClientApi` exposes `turnsPage`, `itemsWindow`, `threadSearch`, `threadCatchUp`,
`threadReadState` and `markThreadRead`. These methods are also forwarded by the
shared worker. Requests accept a plain string `threadId` and standard request
options. Turn pages use exclusive `before` or `after` ordinal cursors. Search
pages use the returned `cursor`; keep the query, filter and scope unchanged.
Search examines at most 128 scoped anchor postings per page, so a page can be
empty while carrying a continuation cursor. Continue until `cursor` is null.
Turn pages are capped at 1 MiB and may contain fewer turns than requested; detail
arrays may be omitted with `truncated` set while counts stay exact.
Turn, search and catch-up responses carry `indexedSeq` and `ready`, so a client can show
migration progress without assuming incomplete historical data is complete.
Search readiness includes turn ownership and descendant discovery as well as FTS coverage.

`itemsWindow({ threadId, aroundSeq, before, after })` or a `turnOrdinal` target
returns a bounded window without modifying the leased thread's live tail. Keep
one jumped window and that live tail. Replace the jumped window on another jump;
discard it when the user closes the jump. To move toward the live tail, request
`itemsWindow({ threadId, aroundSeq: window.itemsAfter + 1, before: 0, after: 199 })`
when `itemsAfter` is non-null. Replace the jumped window with that result. Once
it overlaps the tail by item id, show the tail and discard the jumped window.
Do not accumulate intervening pages. `itemsBefore` and `itemsAfter` are exclusive
creation-sequence cursors, so sparse host sequences do not require scanning.

`threadCatchUp({ threadId, sinceSeq })` or a `sinceTime` cutoff reads deterministic
digests. Time cutoffs select literal event timestamps strictly after the cutoff,
including out-of-order events. Pending approvals and whole-tree status are current.
It never runs a provider. If the user explicitly asks for prose, send an
ordinary `thread.send` through `command` with their summary request. The UI owns
that action and its wording.

`threadReadState({ threadId })` returns the authenticated device's persisted
`lastSeenSeq`. `markThreadRead({ threadId, lastSeenSeq })` coalesces updates for
100 ms per thread into one durable command using the greatest active cursor.
Each caller retains its own abort and timeout. The daemon advances monotonically
and caps the cursor at its current head. An accepted command stays in the normal
outbox until its receipt is acknowledged. Pending unsent read marks are bounded
by the client's request limit.
