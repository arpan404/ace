# @ace/provider-kit

Shared provider I/O for Node 24+. Node built-ins own I/O; Zod validates RPC envelopes. Import modules through their subpaths; discovery never starts agent sessions or reads credential files.

Process groups follow [Node's detached-process semantics](https://nodejs.org/api/child_process.html#optionsdetached); SSE parsing follows the [HTML event-stream rules](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream).

## Processes

```ts
import { spawnSupervised, installShutdownHandlers } from "@ace/provider-kit/process";

// Application-owned SIGINT/SIGTERM handling is opt-in.
const disposeShutdown = installShutdownHandlers({ graceMs: 5_000 });
const proc = spawnSupervised({
  command: "codex",
  args: ["app-server"],
  cwd: workspace,
  env: {},
  name: "codex",
});
proc.stdout.on("line", receiveLine);
proc.stderr.on("line", receiveDiagnostic);
await proc.stop({ graceMs: 5_000 });
```

`stdin` is writable. `stdout` and `stderr` are hot readline streams: attach listeners immediately. Both pipes drain even without listeners. `maxLineBytes` defaults to 16 MiB per line on either pipe. Raw bytes are checked before UTF-8 decoding and readline buffering. Overflow aborts the lifetime signal with an error and kills the owned group. `maxOutputBytes` optionally caps aggregate raw stdout/stderr bytes. Avoid pausing these interfaces or doing blocking work in a line listener. There is no replay buffer or per-consumer queue.

`spawnRawSupervised` exposes readable stdout/stderr byte streams over the same process-group owner. Consumers must drain both streams. It preserves binary bytes and applies the optional shared `maxOutputBytes` cap, without line framing or `maxLineBytes`.

`exited` resolves with `{ code, signal, reason }` after the pipes close. Reasons are `exit`, `signal`, `stopped`, `spawn-error`, or `output-limit`. Line or aggregate output overflow reports `output-limit`. The lifetime `signal` aborts at direct-child exit or spawn failure. `stop` is idempotent and sends SIGTERM to the owned group, then SIGKILL after the grace period. By default, direct-child exit kills all remaining group members, including agent-started dev servers. Set `killGroupOnExit: false` to retain descendants on natural exit. The lifetime signal still aborts immediately. Group ownership remains registered even after the leader exits and all pipes close. `stop()` still sends group SIGTERM, allows the configured grace period, and escalates to SIGKILL; the owner-exit safety net also cleans up retained descendants. Explicit stop releases ownership after cleanup, and repeated stop calls share the same completion. This option can leave `exited` pending until descendants close their pipes. `env` is explicit and merges over `process.env`; the package logs nothing.

On POSIX, each spawn creates a separate process group. A registry contains only group leaders spawned by this module. Spawning installs only a synchronous exit hook as a final SIGKILL safety net. It does not register SIGINT/SIGTERM handlers. Applications can call `installShutdownHandlers({ graceMs })` to stop owned groups with SIGTERM, escalate after the grace period, then restore default termination and re-raise the received signal. The returned disposer removes those handlers without disturbing application handlers. The recorder and doctor opt into this policy. Existing application handlers run on the first incoming signal; final re-raise removes listeners for that signal so the owner terminates by signal. macOS can report EPERM for a group containing only zombies; cleanup tolerates that race and retries when Node reaps the leader.

Windows is rejected explicitly because Node built-ins do not expose Job Objects. Exit hooks cannot run after SIGKILL, a host crash, or a child deliberately escaping its group. Later daemon startup recovery will handle groups recorded in its own state file, as a separate milestone. No unconditional orphan guarantee is possible with exit hooks alone.

`probeOutput(command, args, { timeoutMs, env, maxBytes })` runs bounded, supervised commands and returns trimmed stdout/stderr and exit code. Defaults are 30 seconds and 1 MiB total raw stdout/stderr bytes, including line terminators. Unterminated output counts immediately. `probe` returns stdout on success and rejects failed probes. These functions return raw output to their caller, which must choose what is safe to expose.

## JSON-RPC

```ts
import { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";

const rpc = new JsonRpcPeer(proc, {
  onFrame: (direction, message) => record(direction, message),
  onMalformed: (line) => reportText(line),
  onError: (error) => reportTransportError(error),
});
rpc.onNotification = receiveNotification;
rpc.onRequest = answerProviderRequest;
const result = await rpc.request("initialize", params, { timeoutMs: 30_000, signal });
rpc.notify("initialized");
```

Requests accept explicit string or numeric `id`s. An explicit id cannot be reused during the stdin pipe lifetime, including after cancellation, timeout or success. Generated numeric ids increase monotonically and skip reserved explicit ids. Explicit ids matching past generated ids are rejected. The explicit-id history is bounded to 4096 entries by default, configurable with `maxExplicitIds`; string ids are limited to 1024 UTF-8 bytes. When this history is full, new explicit ids are rejected and generated ids remain available. Reservations are shared by concurrent and replacement peers on that pipe. The first peer configures `maxExplicitIds` for the pipe lifetime; replacement options cannot reset or enlarge that cap. The default deadline is 30 seconds. Inject `schedule(delayMs, callback)` to supply a deadline driver; it returns a cancellation function. The default driver uses Node timers. Set `timeoutMs: null` on a request or peer to allow indefinite human interaction. Deadlines, cancellation, responses and process exit release pending requests and listeners. `close()` disposes the peer without stopping the process. Process completion uses a detachable stdout-close listener, so disposed peers release their callbacks while the owner lives. Final stdout frames still drain after the lifetime signal aborts.

`maxPendingRequests` defaults to 256, `maxMessageBytes` to 16 MiB and `maxQueuedBytes` to 32 MiB. Message and queue limits count serialized UTF-8 bytes, including the newline. Capacity errors reject before writing to stdin. The bounded FIFO hands one write to stdin at a time and waits for its callback and any required drain. Cancelled queued requests are removed; cancelled in-flight bytes remain charged until the write callback. `notify()` returns a promise for write completion and also reports rejection through `onError`, preserving error reporting for callers that ignore its return value. The first peer configures the shared `maxQueuedBytes` cap for the pipe lifetime. Subsequent peers inherit it, including when they supply a different value. Closing a peer rejects its blocked sends and removes its queued messages; active bytes stay charged to the pipe until their write callback. The shared writer remains usable by replacement peers. Pending-request and individual-message limits belong to each peer.

Frames are newline-delimited JSON, parsed with a lenient record schema that preserves unknown fields and raw hooks. Unknown method names, including `cursor/*`, and absent JSON-RPC version tags are accepted. Invalid lines are reported and reading continues. Remote errors reject requests; handler failures receive `-32603` internal error. Throw the exported `MethodNotFound` error for unsupported methods to return `-32601`. The default incoming handler does that; ordinary failures on Cursor extension handlers no longer advertise absent support. `onFrame` gets the parsed raw message in `send` or `recv` direction. Raw hooks can include provider secrets, so logging and redaction belong to the caller.

## SSE

```ts
import { readSse } from "@ace/provider-kit/sse";

await readSse(new URL("/global/event", base), {
  signal,
  headers: { authorization: localServerAuth },
  onEvent: ({ data, event, id }) => receive(data, event, id),
  onReconnect: ({ attempt, delayMs, error }) => reportReconnect(attempt, delayMs, error),
  heartbeat: {
    gapMs: 25_000,
    isHeartbeat: ({ data }) => JSON.parse(data).payload?.type === "server.heartbeat",
    onGap: (elapsedMs) => reportGap(elapsedMs),
  },
});
```

Data stays text; JSON decoding belongs to the adapter. Parsing handles UTF-8, multiline data, comments, event names, ids, BOM and CR/LF/CRLF framing. Incomplete final events are discarded. `maxLineBytes` and `maxEventBytes` each default to 16 MiB of UTF-8 bytes. Event data counts the newlines between data lines. Limits are checked before retaining another fragment or data line. Overflow cancels the response and rejects with `SseLimitError`, including when reconnect is enabled. Reconnects preserve Last-Event-ID and honor numeric `retry` fields. The exponential delay starts at 500 ms and caps at 30 seconds; both are configurable. Each reconnect is reported. Event and heartbeat hook exceptions reject the reader; they do not trigger reconnects. HTTP 204 ends the stream. Caller abort resolves the reader and closes the connection, including during backoff.

Heartbeat gaps are reported once per gap interval until another matching event arrives. With no predicate, any dispatched event counts as a heartbeat. Use `reconnect: false` for one-shot readers. Auth headers are caller supplied and never logged by this module.

## Discovery and doctor

`discoverProviders({ overrides, env, timeoutMs })` returns a record keyed by `claude`, `codex`, `opencode`, and `cursor`. Each result contains `installed`, optional `path` and `version`, `auth`, optional `authDetail`, `authEvidence` and `error`, and `loginHint`. An explicit binary override takes precedence over PATH, including when the override is missing. All version and auth probes run concurrently with a ten-second default timeout; errors stay within the failing provider result.

Only `--version`, `claude auth status`, `codex login status`, `opencode auth list`, and `agent status` are executed. Auth details use fixed labels and allowlisted provider names, never emails, tokens or CLI stderr. OpenCode additionally returns `authEvidence: "credentials_configured"`, shown in doctor's evidence column. It means credentials are configured; remote access has not been validated. Pure parsers are exported for future captured outputs.

```sh
bun run --filter @ace/provider-kit doctor
bun run --filter @ace/provider-kit doctor --json
```

Bun adds workspace log prefixes with `--filter`. For clean machine-readable JSON, run `node packages/provider-kit/src/doctor.ts --json` or `bun run --cwd packages/provider-kit doctor --json`.

The read-only captures and their redaction policy are in [captured CLI fixtures](src/discovery/__fixtures__/README.md).

## Verification

The owner requires tests to run only at merge. Development verification uses static checks. At merge, run `bun run check` for the offline suite. Live tests are skipped by default. Opt in with:

```sh
ACE_LIVE_CLI=1 bun run test packages/provider-kit/src/live.process.test.ts --reporter=verbose
```

The live suite probes versions and auth, starts only `opencode serve`, `codex app-server` and `agent acp`, and sends only initialize/initialized handshakes. It never creates sessions or sends prompts. All started processes are stopped. The OpenCode test uses a fresh local password and an ephemeral port, then waits for connected and heartbeat events.
