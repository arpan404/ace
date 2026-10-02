# @ace/settings

Typed settings for the local daemon and its clients. Schemas live in `@ace/protocol`; resolution, validation and persistence live here. Credentials belong in provider CLIs or the remote-access secure store, never in settings.

```ts
import { SettingsService } from "@ace/settings";

const settings = new SettingsService({ dataDir: "/home/me/.ace" });
const scope = { workspace: "/home/me/project", thread: "thread-123" };
await settings.set("conductor.maxFixRounds", 5, { kind: "global" });
const result = await settings.get("conductor.maxFixRounds", scope);
// { key: "conductor.maxFixRounds", value: 5, provenance: "global" }
const stop = await settings.subscribe({ keys: ["conductor.maxFixRounds"], scope }, (notification) =>
  console.log(notification),
);
stop();
await settings.close();
```

`get` and `set` infer value types from the selected key. `read(selector)` also returns current diagnostics. `subscribe(selector, listener)` registers changes without an initial callback; `read` supplies initial values. A notification carries only selected keys whose effective value or provenance changed. Returned values are frozen. Listener failures do not undo writes or stop other listeners.

Use `refresh(layer)` to reconcile an already observed external change and `settled(layer)` to drain queued work without rereading. Most callers rely on directory watchers with a 75 ms debounce. `FileIO` and `Scheduler` are injectable boundaries for deterministic tests, or integration with another filesystem. Production defaults use async Node file operations. Custom `FileIO.write` implementations must await the optional `beforeCommit` callback immediately before publishing the destination.

## Documents and resolution

```jsonc
{
  "version": 2,
  "settings": {
    // Preferences can be committed with the workspace.
    "providers.coder.model": "default",
    "conductor.planApproval": "required",
    "clients.theme": { "appearance": "dark" },
  },
}
```

Order is defaults, global `settings.json`, workspace `.ace/settings.json`, then `threads/<id>/settings.json` in the daemon data directory. Each dotted key replaces the whole lower-layer value. Theme and keybinding blobs are opaque JSON. Removing a key externally restores its lower-layer value. Duplicate properties, forbidden prototype names and every decoded credential field/string are rejected before JSONC materialization, including shadowed and escaped values. Version 1 used `values` instead of `settings`; reading migrates and atomically persists version 2 once. Unknown keys and document fields survive writes. Unsupported versions and invalid files retain the last good document and produce typed diagnostics.

Writes reread disk immediately before editing. External changes completed before that read survive. Between read and rename, the last writer wins for the entire document. The service does not lock out external editors or implement compare-and-swap. Exclusive temporary files, fsync, rename and directory fsync prevent torn destination files. New/rewritten files have mode 0600; users may chmod committed workspace files separately. Workspace roots are pinned to their canonical identity. Workspace `.ace` directories and settings files must not be symlinks; containment is rechecked immediately before rename. Changing existing values preserves surrounding comments and whitespace. Validated scalar offsets are reused only when the reread exactly matches the cached source; external changes, complex values and insertions receive full validation. Inserting properties can reformat the adjacent line; moving the v1 container can relocate its comments.

## Wire API

The daemon accepts these requests after its existing authenticated `hello`. Reads and subscriptions require device `read` scope; assignments require `operate`. Local host credentials and `admin` include both:

- `settings.get { requestId, key, scope }`
- `settings.set { requestId, key, value, layer }`
- `settings.subscribe { requestId, subscriptionId, keys, scope }`

Scope contains optional `workspaceId` and `threadId`. Thread scopes inherit the daemon's recorded workspace; mismatches fail. Layers are `{ kind: "global" }`, `{ kind: "workspace", workspaceId }` or `{ kind: "thread", threadId }`. Paths never come from the wire. Set requests accept a string key so unknown or forbidden keys receive a typed validation/secret diagnostic.

Responses are `settings.result { requestId, ok, entries, diagnostics }`; entries contain `key`, `value` and `provenance`. Subscriptions receive the initial result, then `settings.changed { subscriptionId, entries }` and `settings.diagnostic { subscriptionId, diagnostic }`. Existing `unsubscribe` releases them. Fetch or subscribe again on reconnect. Settings delivery over the configured transport byte cap closes with code 4009; reconnect and read or subscribe again. These settings operations are asynchronous assignments outside the synchronous command receipt transaction; request IDs correlate replies and are not durable idempotency receipts.

## Limits

A document is at most 1 MiB, nesting at most 64 levels, and each client blob at most 64 KiB. A service owns at most 64 file scopes and 1,024 subscriptions. Each selector has at most 32 keys, each file queue at most 64 operations, and each socket at most 64 subscriptions and 64 pending settings requests. Capacity rejects further work with a `limit` diagnostic; unsubscribe recovers subscription capacity. Inactive healthy scopes are evicted in least-recently-used order when new scopes need space. Operations and subscriptions pin their scopes; unsubscribe releases those references. Invalid scopes also remain pinned to retain their last-good document and diagnostic. Repair invalid scopes or release active subscriptions if all 64 entries are pinned. Cold scope acquisitions cap at 64 queued requests. Physical file aliases retain each logical layer’s provenance. Watch failures retain a diagnostic independently of successful reads and retry on the debounce boundary.

Secret checks reject recursively named credential fields and recognizable credential strings. They cannot identify every arbitrary random credential. Opaque plugin/client blobs obey the same checks. Remote and approval settings express preferences; consumers must still enforce trust and authorization rules.

`bun run --filter @ace/settings bench` reports non-gating cached reads, assignments with indexed subscriber fan-out, watcher scheduling, changed external reconciliation and scalar writes with large unrelated payloads. See [review verification](REVIEW-VERIFICATION.md) for current results. The benchmark uses an in-memory file boundary to isolate CPU costs; integration tests exercise real files, atomic replacements, watchers and WebSockets.
