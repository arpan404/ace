# @ace/client-worker

Runs `@ace/client` off the main thread (ADR 0056). `ClientHost` lives in a SharedWorker (or a dedicated Worker where SharedWorker is missing) and owns one `Client` per daemon target: the socket, frame decoding, projection and the intents outbox. `RemoteClient` lives in each tab and implements `ClientApi` over a `MessagePort`.

- Tabs lease stores. The host forwards the change keys each leased store emits, coalesced per frame, as fine-grained patches: the key's new value, or only the text a streaming message gained. A tab's mirror applies them and notifies the same keys, so `@ace/client-react` selectors behave as they do in-process.
- A hidden tab (`Visibility`) receives nothing; when it is shown it receives every key that changed meanwhile.
- Requests (`command`, `registry`, `itemsPage`, `loadOlder`, `outputRead`, `text`, `output`) run on the worker's client; abort signals cross the port.
- Tabs ping; a tab silent for `silenceMs` is dropped and its leases released. A client outlives its last tab by `lingerMs`, so a reload reattaches to a warm socket.

The browser entry and the IndexedDB outbox are in `apps/web/src/boot/client-worker.ts` and `idb-storage.ts`.

`idbOutbox(key, seed)` provides record-level IndexedDB storage and atomically
migrates the old `ace/outbox` aggregate or localStorage seed once. Web boot should
import this adapter from `@ace/client-worker` in place of its local
`boot/idb-storage.ts` adapter. Each enqueue or receipt writes only its own intent.

Pending sends use a lifetime removal channel, including tabs with no mounted
subscriber. Both `command()` and `enqueue()` caches evict settled drafts by
count and bytes. Unwatched full intent records are capped at 64 and 8 MiB,
further restricted by `unwatchedIntents`. Hidden tabs coalesce at most 256
changed pending IDs, then send one bounded reset when visible. A normal frame
reads only changed IDs.

`RemoteOptions.id` remains optional. Supply an injected generator when available;
otherwise `start()` assigns a worker-generated prefix using the underlying
client's injected generator. Calls before attachment need their own generator
or explicit command ID. Runtime logic never falls back to ambient randomness.

Native IndexedDB regression tests use a temporary Chromium profile and a local
HTTP origin. The merge runner needs the Playwright Chromium installation; these
tests and performance benchmarks are not executed during implementation under
the owner's rule. See ADR 0066 for receipt ownership and memory limits.

MachinePool's `command`, `enqueue` and `create` route durable work to the same
previously verified machine connection while its transport is offline. They keep
the caller's command ID; other machines cannot acknowledge or replace the draft.
One-shot pool access still requires an online connection. Retain the host's
`ClientApi.pendingSends` selection to observe saving, receipts and delivery
across disconnects. Removed, unverified and auth-failed machines reject new
pool sends. Worker replacement loads only that host/device's record outbox;
the platform's spawn adapter must supply `idbOutbox` under that scope.
