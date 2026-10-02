# @ace/adapter-opencode

OpenCode's v1 HTTP routes and `/global/event` SSE translated into `@ace/core` facts. Supported CLI versions are `>=1.18.33 <2`; the committed recordings cover 1.18.33. Unknown events and parts become raw notice items, and unknown tools remain custom calls with their original name and input.

```ts
import { createOpenCodeAdapter } from "@ace/adapter-opencode";

// Create one adapter for the daemon. Every thread shares its server.
const adapter = createOpenCodeAdapter();
const translator = adapter.createTranslator({ threadId, rootKey });
const session = await adapter.openSession({
  threadId,
  cwd,
  model: "provider/model", // optional; otherwise the CLI chooses its default
  onFrame,
  onExit,
  signal,
});
await session.send([{ type: "text", text: input }], "queue");
await session.close("idle");
```

The factory implements ADR 0007's `ProviderAdapter` and adds a daemon-wide `close()`. `adapter` and `opencodeAdapter` export a default owner for consumers that use a module directly. Each factory owns at most one server, resolves the user's installed CLI through provider-kit discovery, sets a fresh local server password, selects an ephemeral port, and waits for the SSE handshake before opening threads. All HTTP requests carry `?directory=`. The last closed thread stops the server; a later open starts a new server and can resume a native session through REST.

Use `config: { provider: "opencode", liveness: "transport", silenceMs: 25_000 }` in core. Heartbeats keep the entire tree healthy during long tool calls and retries. A heartbeat gap closes and reconnects the SSE transport before resync. A disconnect expires current interactions and emits explicit `transport: "lost"` lifecycle evidence; successful recovery emits `transport: "restored"`. Reconnect reads session metadata, recursive children, messages and parts, pending permissions/questions and the status map. History is decoded value by value in pages of 128 using `limit` and `before`; later reconnects stop at the previous history head. Live and buffered events use the same directory, project and session-tree filter. Only owned events can request a second snapshot pass, and recovery has a two-pass bound. Snapshot-included deltas remain raw evidence on `sse.buffered`; snapshot coverage stops at each request-start ordinal for both live and terminal updates. Idle snapshots stay staged until final reconciliation. Newer events from both recovery passes reconcile before idle snapshots settle turns. Only the latest update per entity is replayed; a running tool is registered before its owner idles, and newer idle or tool completion cannot be discarded by an older snapshot. Queued input stays held throughout recovery. Recovery failure stops the owned process and reports exit.

The translator uses core's shared `agent.disconnected` and `agent.reconnected` facts from PR #14. Disconnection immediately reports unresponsive for the affected agents, including children first discovered during recovery. Heartbeats and restored busy snapshots cannot clear that uncertainty; successful resync does. Core retains the owner's `needs_you > working > waiting > unresponsive > done` thread precedence. A live background task therefore keeps the thread waiting during transport loss, while the affected agents remain unresponsive.

The translator creates children before task metadata arrives, then links their spawn item. Background jobs stay live until the parent receives the injected task result. A session-owned three-second timer supplies the translator's fallback tick when a child idles without delivering a result. Busy or retry cancels that deadline. Interrupted tools that remain running become background tasks before the turn ends; later terminal updates settle those tasks. Duplicate native idles do not create another run.

OpenCode has no native steering. `send(..., "queue")` waits for the root, children, background results and human interactions to settle; `"steer"` rejects. The engine normally owns queueing, so this is a defensive queue for direct session consumers. Delivery uses the translator's pure settlement model, including live tools after abort. `interrupt` explicitly visits known descendants when cascade is requested. OpenCode's own abort can cascade even without that flag. `stopTask` aborts a native child session, or the owner of a surviving tool. Approval keys use native request IDs and options `once`, `always`, `reject`. Shutdown immediately cancels local requests, unsubscribes, and rejects queued work. It then attempts a cascade abort with a one-second bound before releasing the server. Question answers are keyed by `<requestId>#<index>`; dismissal uses `/reject`. Plan approval replies `Yes`, and rejection/cancellation use `/reject`.

`plan_exit` becomes a plan review. The review includes the path and contents observed in successful writes or edits to `.opencode/plans/*.md`; when the CLI exposes no contents, markdown is empty. Background visibility is partial because detached shells are invisible to the provider. Experimental `session.next.*` frames are retained as raw data; this adapter drives the recorded v1 routes.

`ServerOptions.runtime` accepts replacements for wall and monotonic clocks, entropy, port allocation, discovery, process spawning, HTTP fetch, SSE transport, and timer scheduling. Defaults live in a separate I/O boundary. `startupTimeoutMs` and `shutdownTimeoutMs` configure process handshake and graceful abort bounds. Receipt clock frames convert epoch retry deadlines into the engine's supplied clock; historical message timestamps never set this offset.

The translator keeps compact routing descriptors for live parts and a 256-entry completed-part window, plus 1,024 message headers, sent/result IDs, and sync aggregate cursors. Event deduplication has a 10,000-ID window. It does not retain transcript strings or tool inputs/outputs in its caches. Core owns accumulated content. Delta translation and delivery settlement are independent of conversation length. Late deltas outside the completed-part window remain raw notices. Background jobs are indexed by child and tool item. An indexed heap keeps one entry per active grace deadline; status changes visit only the affected child's jobs, and ticks visit only due jobs.

Sent message IDs use the native time-prefix layout so REST history retains its order. This implementation was written from the [primary identifier contract at the recorded revision](https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/opencode/src/id/id.ts), the [provider research](../../docs/research/providers/opencode.md), and [fixture analysis](../../docs/research/fixtures/opencode.md). No legacy implementation was used.

During authoring, run only `bun run fmt`, `bun run lint`, `bun run typecheck` and `bun run check:size`. The owner defers tests, probes, mutations and benchmarks to merge. See [verification](VERIFICATION.md) for checkpoints, regression coverage, mutation plans, historical measurements and dependency integration.

At merge, the live health/SSE handshake is opt-in:

```sh
ACE_LIVE_CLI=1 bun run test packages/adapter-opencode/src/live.test.ts
```

It never creates a session or sends a prompt.

The merge-time benchmark scripts use only the pure translator or the boundary CLI double. Do not run them during authoring:

```sh
node --expose-gc packages/adapter-opencode/benchmarks/translator.ts
node packages/adapter-opencode/benchmarks/recovery.ts
node --expose-gc packages/adapter-opencode/benchmarks/live-tree.ts
```
