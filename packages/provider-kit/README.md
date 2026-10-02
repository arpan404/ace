# @ace/provider-kit

Shared provider I/O for Node 24+. Node built-ins only. Import modules through their subpaths; discovery never starts agent sessions or reads credential files.

Process groups follow [Node's detached-process semantics](https://nodejs.org/api/child_process.html#optionsdetached); SSE parsing follows the [HTML event-stream rules](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream).

## Processes

```ts
import { spawnSupervised } from "@ace/provider-kit/process";

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

`stdin` is writable. `stdout` and `stderr` are hot readline streams: attach listeners immediately. Both pipes drain even without listeners. Avoid pausing these interfaces or doing blocking work in a line listener. There is no replay buffer or per-consumer queue.

`exited` resolves with `{ code, signal, reason }` after the pipes close. Reasons are `exit`, `signal`, `stopped`, or `spawn-error`. The lifetime `signal` aborts at direct-child exit or spawn failure. `stop` is idempotent and sends SIGTERM to the owned group, then SIGKILL after the grace period. When the direct child exits, cleanup kills any remaining group members so inherited pipes cannot hold teardown open. `env` is explicit and merges over `process.env`; the package logs nothing.

On POSIX, each spawn creates a separate process group. A registry contains only group leaders spawned by this module. Synchronous exit hooks and SIGINT/SIGTERM handlers kill those groups, never processes matched by name. Application signal handlers can still perform their own shutdown. macOS can report EPERM for a group containing only zombies; cleanup tolerates that race and retries when Node reaps the leader.

Windows is rejected explicitly because Node built-ins do not expose Job Objects. Exit hooks cannot run after SIGKILL, a host crash, or a child deliberately escaping its group. Those cases need platform supervision beyond process groups. No unconditional orphan guarantee is possible with exit hooks alone.

`probeOutput(command, args, { timeoutMs, env, maxBytes })` runs bounded, supervised commands and returns trimmed stdout/stderr and exit code. Defaults are 30 seconds and 1 MiB total captured line output. `probe` returns stdout on success and rejects failed probes. These functions return raw output to their caller, which must choose what is safe to expose.

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

Requests accept explicit string or numeric `id`s. Callers must avoid reusing ids whose cancelled or timed-out responses may still arrive. Generated numeric ids avoid currently pending ids. The default deadline is 30 seconds. Set `timeoutMs: null` on a request or peer to allow indefinite human interaction. Deadlines, cancellation, responses and process exit release pending requests and listeners. `close()` disposes the peer without stopping the process.

Frames are newline-delimited JSON. Unknown method names, including `cursor/*`, and absent JSON-RPC version tags are accepted. Invalid lines are reported and reading continues. Remote errors reject requests; handler failures receive a JSON-RPC error response. `onFrame` gets the parsed raw message in `send` or `recv` direction. Raw hooks can include provider secrets, so logging and redaction belong to the caller.

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

Data stays text; JSON decoding belongs to the adapter. Parsing handles UTF-8, multiline data, comments, event names, ids, BOM and CR/LF/CRLF framing. Incomplete final events are discarded. Reconnects preserve Last-Event-ID and honor numeric `retry` fields. The exponential delay starts at 500 ms and caps at 30 seconds; both are configurable. Each reconnect is reported. Event and heartbeat hook exceptions reject the reader; they do not trigger reconnects. HTTP 204 ends the stream. Caller abort resolves the reader and closes the connection, including during backoff.

Heartbeat gaps are reported once per gap interval until another matching event arrives. With no predicate, any dispatched event counts as a heartbeat. Use `reconnect: false` for one-shot readers. Auth headers are caller supplied and never logged by this module.

## Discovery and doctor

`discoverProviders({ overrides, env, timeoutMs })` returns a record keyed by `claude`, `codex`, `opencode`, and `cursor`. Each result contains `installed`, optional `path` and `version`, `auth`, optional `authDetail` and `error`, and `loginHint`. An explicit binary override takes precedence over PATH, including when the override is missing. All version and auth probes run concurrently with a ten-second default timeout; errors stay within the failing provider result.

Only `--version`, `claude auth status`, `codex login status`, `opencode auth list`, and `agent status` are executed. Auth details use fixed labels and allowlisted provider names, never emails, tokens or CLI stderr. OpenCode's status means credentials are configured, not that remote authentication was validated. Pure parsers are exported for future captured outputs.

```sh
bun run --filter @ace/provider-kit doctor
bun run --filter @ace/provider-kit doctor --json
```

Bun adds workspace log prefixes with `--filter`. For clean machine-readable JSON, run `node packages/provider-kit/src/doctor.ts --json` or `bun run --cwd packages/provider-kit doctor --json`.

The read-only captures and their redaction policy are in [src/discovery/**fixtures**](src/discovery/__fixtures__/README.md).
