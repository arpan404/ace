# @ace/preview

Backend library for opening a host's dev servers in a real browser. It streams HTTP bodies, SSE and websocket traffic without retaining application bodies. See [ADR 0008](../../docs/adr/0008-preview-gateway.md) for the security and wire contract.

## Gateway

```ts
import { createPreviewGateway } from "@ace/preview";

const gateway = await createPreviewGateway({
  host: "0.0.0.0", // Select the LAN/Tailscale interface in production.
  wildcardHost: "preview.example.test",
  tls: { key, cert }, // A browser-trusted wildcard certificate.
  authority: {
    authorize: async (deviceToken) => pairedDevices.verifyToken(deviceToken),
    isPaired: async (deviceId) => pairedDevices.isActive(deviceId),
  },
});
const origin = gateway.register({ port: 3000 });
const link = await gateway.mintLink({ port: 3000, deviceToken });
// Open link on the paired device. It sets a cookie and redirects to origin + '/'.
```

`register` is a trusted daemon control action. It never opens anonymous access. Upstreams use HTTP on `127.0.0.1:<port>` or `[::1]:<port>`. Resolution is pinned to those two addresses, with automatic family selection; DNS cannot redirect an upstream. Discovery does not register anything automatically. Unknown Host, foreign Origin, unsigned requests and unauthenticated upgrades fail closed. Gateway cookies never reach the dev app; app cookies become host-only. Redirects to the upstream's loopback port point back to the preview origin.

Configure wildcard DNS to resolve preview hosts to the daemon's LAN or Tailscale address. A bare IP address and a default MagicDNS name do not provide hostname cookie isolation. TLS is needed for remote service workers and Secure cookies. An omitted `tls` explicitly chooses HTTP for development. Avoid hosting preview names under the ace application's cookie domain. Cookies are not isolated by port number.

Default caps are 64 registrations, 512 outstanding links and 512 connections/active requests. Link lifetime is 60 seconds; signed session lifetime is one hour. A fresh registration generation and daemon restart invalidate old sessions. Call `revokeDevice(deviceId)` when pairing is revoked to terminate already-open streams and reject pairing lookups in progress; `isPaired` blocks future requests. `unregister(port)` cancels that preview's work. `close()` destroys every owned socket. `stats()` reports connection counts and buffered stream bytes without retaining bodies. Relay stats include held socket chunks, admitted frame bytes and adapter-reported send/receive queues. `previewRelayChannel` supplies the real encrypted transport counters.

## Discovery and launch

`discoverListeningPorts()` reads macOS `lsof` or Linux `/proc/net/tcp{,6}`. `pollPorts({ scan, onChange, onError, signal, wait })` emits only added/removed ports and backs off from one to 30 seconds while unchanged. Supply an abortable timer as `wait`; there is no hidden polling singleton. Snapshots are bounded at 4 MiB.

Feed chunks from the terminal package to `new TerminalUrlScanner().feed(chunk)`. The scanner reports complete loopback HTTP(S) URLs once their delimiter arrives. `flush()` completes an unterminated final URL. Each call accepts at most 64 KiB and keeps at most 8 KiB across calls. URL suggestions have no forwarding permission.

`loadLaunchFile(workspaceRoot)` reads `.ace/launch.json`:

```json
{
  "configurations": [
    {
      "name": "web",
      "runtimeExecutable": "bun",
      "args": ["run", "dev"],
      "cwd": ".",
      "env": { "NODE_ENV": "development" },
      "autoPort": true
    },
    { "name": "existing", "url": "http://localhost:3000" }
  ]
}
```

`createLaunchManager({ root, env, onOutput }).start(config)` starts a supervised process group, or attaches without owning the existing server. Commands are executables plus arguments, not shell expressions. `port` injects a specified `PORT`; `autoPort` selects a free one and overrides `PORT`. Arbitrary CLIs cannot inherit the reservation, so a bind race remains between releasing the reservation and the executable listening. Start returns a handle with `url`, `process.exited` and `stop()`. The manager also exposes `list()`, `stop(name)` and `close()`. A shutdown waits for pending starts and stops owned processes. Preview launches kill processes producing a stdout/stderr line longer than 64 KiB, before readline can accumulate it. Each delivered output line is capped at 8 KiB. Attach URLs must be loopback HTTP and never execute a command.

## Relay and native clients

```ts
import { attachPreviewRelay, openPreviewProxy } from "@ace/preview";

// Host: identity and authorization belong to the paired secure-channel owner.
const host = attachPreviewRelay({ channel: hostPreviewChannel, allowPort });
// Electron/Node client:
const proxy = await openPreviewProxy({ channel: clientPreviewChannel, port: 3000 });
// proxy.url is http://p3000-<generation>.localhost:<listener-port>
// Dispose proxy.close() and host.close() with their paired channel.
```

Each proxy owns an exclusive ordered preview subchannel. The adapter implements `send(Uint8Array)`, `subscribe(onFrame, onClose)` and `close()`. Incoming frames transfer buffer ownership to preview; adapters must not mutate or reuse their buffers. Outgoing frames remain immutable. Sends must resolve under bounded transport admission, preserve invocation order, and fail on disconnect. Fatal protocol errors close both peers. Do not feed arbitrary daemon/relay frames into the preview decoder. The host's `allowPort` must check the paired identity's preview permission and the currently approved forwarded-port set. No provider credentials enter the channel.

TCP streams use 16 KiB frames, 256 KiB credit per direction and a default 256-stream cap. A reconnect discards old streams. New HTTP requests and websocket reconnects use a new proxy/channel, without replaying old writes. HTTP forwarding on loopback rewrites Host, Origin and Location as the gateway does. Its internal TCP bridge authenticates a 32-byte capability before opening a relay stream, so guessing the internal listener port does not bypass the HTTP checks.

`@ace/preview/transport` is the portable client entry, without Node runtime imports. Its `openPreviewProxy({ channel, port, runtime })` accepts a `PreviewLoopbackRuntime` supplied by a mobile native TCP/HTTP bridge. The bridge must expose bounded sockets with the `PreviewSocket` event contract, bind only loopback, allocate a distinct `*.localhost` hostname, reject other Host/Origin values and CONNECT, stream request/response bodies, and authenticate any internal bridge listener. Exported `requestHeaders` and `responseHeaders` supply the same rewriting policy to that bridge. The Node entry supplies this runtime automatically and is exercised with real sockets. Expo's native TCP/HTTP bridge and client UI are future client work, not bundled here. Browser runtimes must resolve `*.localhost` to loopback; native apps can provide a resolver rule where needed.

Ordinary browsers cannot create a loopback listener or connect to raw TCP through the encrypted relay. Remote browsers use LAN or Tailscale with configured wildcard DNS.

## Verification

`bun run check` runs the repository gate. `bun run --filter @ace/preview bench` measures URL scanning, listener snapshots, bounded process output, HTTP fan-out and 50 MiB gateway/relay downloads. Benchmarks are informational and print throughput, peak RSS and RSS change. RSS includes Node/V8 allocator retention and temporary reclaimed buffers; the streaming tests additionally assert less than 8 MiB retained byte-buffer growth in an isolated GC-enabled process, bounded live queues and first-byte delivery before the upstream completes. Relay measurements use an ordered bounded in-process channel edge while all TCP and HTTP endpoints are real; encrypted-channel cost is not included.

A blocked transport cannot accumulate unlimited control responses; pending sends have a cap proportional to the stream cap, and overflow closes the endpoint. Channel close disposes the loopback listeners.

The tests cover real HTTP, TLS, websocket, SSE, 50 MiB streaming, 200 concurrent connections, cookie jars on two virtual hosts, authentication bypasses, expiry, single use, revocation during pairing lookup, reconnects, relay credit abuse, stream-cap admission, real listener discovery and supervised launch lifecycle. The PR records deliberate production mutations and their failing behaviour tests.

The daemon's `startDaemon` accepts optional `DaemonPreviewOptions` as its sixth argument and returns `preview` when configured. It binds the requested interface and uses the persistent paired-device store. Register a port through `daemon.preview.register({ port })` from trusted host control. Paired clients request `POST /v1/previews/<port>/link` on the daemon's local HTTP or pinned remote HTTPS listener with `Authorization: Bearer <device-token>`; the response is `{ url }`. Host token-file credentials cannot mint links. Device revocation immediately terminates preview streams; daemon shutdown closes its preview listener. Read-only paired devices can browse previews; registering, launching and selecting the allowed ports belong to host control.

Terminal hooks and client dispatch remain additive integration points. The protocol controls live at `@ace/protocol/preview`; no existing daemon wire union is changed.

`previewRelayChannel(hostOrClientChannel)` adapts the landed `@ace/relay` binary API. Allocate a dedicated encrypted connection, receive and authenticate its initial hello, and call `hostChannel.authorize()`. Attach the host preview endpoint before sending a JSON acknowledgement of the switch. The client consumes that acknowledgement before opening its preview proxy. From then on the adapter is the channel's sole reader; do not run a daemon JSON iterator alongside it. The host's port approval and revocation must remain tied to the authenticated paired identity. Real-relay tests exercise Noise pinning, concurrent HTTP, cookie/header rewriting, websocket echo and channel/listener disposal. The benchmark now also includes a 50 MiB transfer through the real encrypted relay with its traffic-rate limit raised for measurement.

Scheme-relative loopback redirects resolve against the upstream origin and stay on the preview origin. Ordinary relative and external redirects retain their meanings. Port polling copies each scanner result before diffing, so a scanner may reuse its Set. Launch/proc reads open nonblocking, validate the opened descriptor as a regular file, and close on rejection; proc tables with zero reported size still read to EOF. FIFOs cannot occupy the filesystem worker pool.

A local relay socket close removes its stream and wakes credit/admission waits immediately. Graceful EOF still queues END after DATA. Native bridges must honor pause and emit at most one pending byte chunk, capped at 256 KiB. Oversized or overlapping chunks reset the stream. The benchmark also measures 1,000 credit-exhausted socket closes at a controlled native-I/O boundary, checking that every close releases capacity and byte queues. This phase measures mux cleanup rather than kernel/network cost.

The large-transfer and isolated-memory tests have 60-second correctness timeouts. The memory probe receives the test's cancellation signal and its cleanup waits for the supervised child to exit; a real child-server test verifies probe cancellation closes the server before completion. Timing thresholds do not gate throughput.
