# @ace/client-worker

Runs `@ace/client` off the main thread (ADR 0050). `ClientHost` lives in a SharedWorker (or a dedicated Worker where SharedWorker is missing) and owns one `Client` per daemon target: the socket, frame decoding, projection and the intents outbox. `RemoteClient` lives in each tab and implements `ClientApi` over a `MessagePort`.

- Tabs lease stores. The host forwards the change keys each leased store emits, coalesced per frame, as fine-grained patches: the key's new value, or only the text a streaming message gained. A tab's mirror applies them and notifies the same keys, so `@ace/client-react` selectors behave as they do in-process.
- A hidden tab (`Visibility`) receives nothing; when it is shown it receives every key that changed meanwhile.
- Requests (`command`, `registry`, `itemsPage`, `loadOlder`, `outputRead`, `text`, `output`) run on the worker's client; abort signals cross the port.
- Tabs ping; a tab silent for `silenceMs` is dropped and its leases released. A client outlives its last tab by `lingerMs`, so a reload reattaches to a warm socket.

The browser entry and the IndexedDB outbox are in `apps/web/src/boot/client-worker.ts` and `idb-storage.ts`.
