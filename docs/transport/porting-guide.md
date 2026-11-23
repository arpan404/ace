# Porting the transport to Rust, and leaving Bun

For the builders who move the daemon's transport into `native/daemon` (`ace-transport`) and, at
the end, make `ace-daemon` the program (`ace-daemon-bin`). One work item per branch. Read
[ADR 0226](../adr/0226-the-daemon-leaves-bun.md) and [behaviour.md](behaviour.md) first: the
contract there is what you keep, and behaviour.md §12 lists the tests by class. The rules of the
[engine porting guide](../engine/porting-guide.md) (switches, refusing to start without the native
part, tests run alone with the switch on and off, the cross-mode gate) apply unchanged; this guide
adds what is particular to the transport.

Branch from `ace/daemon-rust-rewrite` once the item's needs are merged, one branch per item
(`ace/rust-transport-<item>`). Load limits on the shared machines: `--maxWorkers=4`,
`CARGO_BUILD_JOBS=4`, no full suite, one bench at a time (below).

## Rules particular to the transport

1. **Clients see nothing change.** Bytes a client parses, close codes and reasons, HTTP statuses
   and headers, the connect sequence's round trips, frame sizes and compression choices are kept.
   A difference is a bug in the port unless ADR 0226 lists it.
2. **Decode the envelope, forward the body.** The transport reads a client message's `type` and
   its routing ids with `ace-json` and hands the message, as received, to its owner. A TypeScript
   owner gets the original string and runs today's Zod decoder (`services/socket-message.ts`);
   never re-encode a message on its way to TypeScript. A Rust owner decodes with its generated
   `ace-protocol` type.
3. **Everything a client parses goes through `ace-json`** (ADR 0225 safeguard 1): server messages
   in their schema's key order, strings as `JsString`, stored JSON spliced as stored. No
   `serde_json` on a wire value.
4. **One route table.** `native/daemon/catalog/routes.json` names each client message type's owner
   (`rust:<crate>` or `js:<service>`) and each HTTP route's (`rust:` or `js:`). It is generated
   from the Zod unions and the registry; `check:daemon-native` fails on a message type without an
   owner. Moving a type to Rust is a one-line change there plus the handler.
5. **Bridges keep order.** `JsSocketService` feeds each socket's TypeScript sessions one ordered
   queue, as `SocketInput` does (`socket-input.ts`); a Rust handler for a type and a TypeScript
   one for the next type on the same socket still run in arrival order. Liveness frames are
   answered on arrival, never behind either.
6. **Decisions on the pump, bytes on tokio.** Anything that reads or changes daemon state (device
   rows, subscriptions, lanes, admission counts) runs on the core's executor (ADR 0223 §4). Accept,
   TLS, framing, compression and socket reads and writes run on tokio. No lock is shared between
   them; they talk through the queues ADR 0223 §4 defines (one scheduling claim, budgeted turns).
7. **No history-sized work on the pump** (ADR 0170): replays, snapshots and pages are bounded;
   wire reads (T4) run on the reader pool.
8. **Secrets never sit in transport buffers longer than a message**: tickets, tokens, pairing
   codes and grants are dropped (and their buffers zeroed where the TypeScript does,
   `socket-input.ts:83`) after handling. Compression follows `compression-policy.ts`'s allowlist,
   ported as data.
9. **Tests move, they don't multiply.** The (a) files of behaviour.md §12 are the proof and are
   not edited, except `socket-test-support.ts` and the launch helpers, which learn the switch. (b)
   cases move into `#[cfg(test)]` beside the Rust function that replaces their module. No parity
   harness, no second suite.

## Work items

### T0: skeletons and the route table (needs ADR 0223 E0)

- Crates `ace-transport` and `ace-daemon-bin` in `native/daemon`, empty but built and linted.
- `scripts/generate-rust-protocol.ts` gains the transport's roots (`hello`, `welcome`, `subscribe`,
  `unsubscribe`, `snapshot`, `snapshot.part`, `events`, `items.page`, `items.window`, `turns.page`,
  `turn.steps`, `thread.catchUp`, `threads.patch`, `fail`, `ping`, `pong`).
- The route table generator and its check.
- Switch names in `native-switches.ts`: `ACE_TRANSPORT`, `ACE_HTTP`, `ACE_RELAY`, `ACE_DAEMON`,
  and `wire`/`sidebar` values of `ACE_STORE_READS`.
- The baseline measurements below, scheduled by the owner.

### T1: sockets (needs T0)

1. **Spike first, written down**: per-message deflate (ADR 0226 question 1). `tungstenite` 0.30
   refuses RSV1 frames (`src/protocol/mod.rs:643`). Try, in order, a WebSocket crate with RFC 7692
   server support (check its licence against `deny.toml` and its maintenance), then our own RFC 7692
   extension over a framing layer that exposes RSV1. Record the result in the PR; the proof is
   `remote-compression.server.process.test.ts` unchanged, plus a browser client and the iOS client
   negotiating it (owner-run).
2. Listeners on hyper: loopback, LAN TLS, Tailscale TLS with SNI, run-time toggling
   (`remote-runtime.ts`, `remote-direct.ts`), the `remoteStarted` promises' semantics.
3. Upgrade admission (`socket-upgrade.ts`), the 256-socket cap, pre-auth budgets
   (`socket-admission.ts`), the 1 MiB inbound limit.
4. WebSocket framing, pings, idle sweep, close grace (`server-socket-close.ts`), close logging
   (`socket-liveness.ts`).
5. Outbox, frame holder, ordered socket, input backpressure (`outbox.ts`, `frame-holder.ts`,
   `ordered-socket.ts`, `socket-input.ts`).
6. The bridge: after framing, every message goes to the TypeScript main-socket handler
   (`server.ts`'s connection handler) as a string, and every TypeScript send comes back as a
   string or a binary buffer with its compression and hold flags.
7. `startServer` with `ACE_TRANSPORT=native` starts the Rust listeners and returns the same object.

Proof: `socket-admission.server`, `socket-close-log.server`, `remote-compression.server`,
`tailscale-https.server`, `server.process`, `socket-liveness.process`, `sni-listener.process`,
`tls-identity-node.process`, `frame-packing.process`, `outbox-work.process`, `remote-direct.process`,
then every `fixture()` file, each alone, switch on and off. Bench gate: fan-out and head-of-line
(below) no worse; if worse, T1 waits and ships with T3 (ADR 0226 §6).

### T2: hello, authentication, devices (needs T1, `ACE_STORE=native` default-on)

`socket-hello.ts`, `remote-auth.ts`, `ticket-pool.ts`, `pairing-codes.ts`, `pairing-issue.ts`,
`devices.ts`, `client-access.ts`, `local-token.ts`, `relay-hello.ts`' account hello, the account
grant socket (`account-access/grant-socket.ts`, `grant-lease.ts`), the org socket policy's
admission checks (`org-access/socket-wiring.ts`). Device and ticket rows through `ace-store` on the
main connection. Cross-mode list: `auth.server`, `handed-ticket.server`, `remote-restart.server`
(device rows and tickets written by one backend are honoured by the other after a restart).

### T3: subscriptions and fan-out (needs T2)

`subscription.ts`, `sidebar-subscription.ts`, `wire-encoder.ts`, `event-encodings.ts`,
`wire-interactions.ts`, `socket-reads.ts`, `socket-commands.ts`, `command-lanes.ts`,
`@ace/projection`'s `wire-trim` and `short-deltas`. Until store phase 5, events arrive from the
TypeScript store's publication through `JsEventSource` with their encodings; after it, from
`ace-store` directly. Snapshots and pages are still read by TypeScript in T3 and handed over as
strings.

### T4: reads to the wire (needs T3, store phase 5)

ADR 0226 §4. Items pages and windows first, then snapshots and catch-up, turns and steps, then the
sidebar once `ThreadCache` is fed by the Rust writer. Trusted rows spliced as stored; untrusted rows
through the TypeScript lenient decoder as a port. When a wire read is default-on, its TypeScript
shaper's JavaScript callers switch to a facade parsing the Rust bytes, and the shaper is deleted one
release later.

### T5: HTTP routes (needs T1 and ADR 0225 M2)

The chains of behaviour.md §3, in their order. A route not yet in Rust is a `JsHttpRoute` in its
position. Port `access-http.ts` with T2; `attachments-http.ts`, `attachments-upload.ts` and
`attachment-response.ts` with the store; `web-http.ts` (static files, the web root) and
`icons-http.ts` early; `preview-http.ts` with the preview owner; Suits with their owner.

### T6: relay (needs T2)

`relay-socket.ts`, `relay-machine-host.ts`, `relay-route.ts`, `relay-http.ts`, `relay-nk/`,
`services/relay-channel.ts`, `services/relay-attachments.ts`, `@ace/relay`'s host side, and
`@ace/secure-channel` replaced by `snow`. `@ace/secure-channel`'s vector files
(`noise-nk-vectors`, `media-vectors`) run against the Rust implementation through the binding.
Built with the machines ADR's relay link.

### T7: the inversion (needs ADR 0226 §5's preconditions)

`ace-daemon-bin`'s `main`, ported from `index.ts` with `config.ts`, `services/service-order.ts`,
`services/startup*.ts`, `shutdown*.ts`, `process-daemon.ts`, `daemon-log.ts`, `fatal-log.ts`,
`stall-log.ts`; the launcher change in `@ace/service` (`daemon-program.ts`, `process-names.ts`,
`launcher.ts`); `ace.mjs` as a forwarding shim for one release.

### T8: packaging (needs T7 default-on for one release)

`tools/release/src/daemon-runtime.ts`, `bundle.ts`, `build.ts` and the smoke tests: `ace-daemon` in
every layout; Bun moved to a children-only runtime with each child bundled on its own.

## Measurements to schedule

None of these has been run for ADR 0226. They run **one at a time** on a quiet machine, when the
owner schedules them, never beside another bench; if a switches-off-versus-on run of another bench
covers the same workload, its off-side numbers are the baseline and are cited with its date and
commit. Every run uses a throwaway home (the benches make their own under the OS temp folder),
never `~/.ace` or a copy of it.

Setup once per checkout: `bun install`, then the native parts the daemon needs from source:
`bun run --filter @ace/workspace build:native` and `bun run --filter @ace/terminal prepare-native`
(without the first, adding the bench's project fails with `project_path_changed`).

1. **Transport share of daemon CPU, per turn and at idle.** The daemon bench with Bun's CPU
   profiler, run from source so the profile names source files. A shim on `PATH` adds the profiler
   only to `serve`, and the bench runs on Node so it finds the shim (`bunBinary` uses `PATH` when
   not on Bun):

   ```sh
   mkdir -p /tmp/ace-0226/{bin,prof,idle,turns}
   cat > /tmp/ace-0226/bin/bun <<EOF
   #!/bin/sh
   case " \$* " in
     *" serve "*) exec $(command -v bun) --cpu-prof --cpu-prof-interval=500 --cpu-prof-dir=/tmp/ace-0226/prof "\$@" ;;
     *) exec $(command -v bun) "\$@" ;;
   esac
   EOF
   chmod +x /tmp/ace-0226/bin/bun
   # idle only (startup, 10 s settle, warm-up turn, 60 s idle)
   PATH=/tmp/ace-0226/bin:$PATH node tools/daemon-bench/src/run.ts --entry=apps/daemon/src/cli.ts \
     --idle-ms=60000 --new-threads=0 --same-thread-turns=0 --long-text-turns=0 \
     --output=/tmp/ace-0226/idle.json && mv /tmp/ace-0226/prof/* /tmp/ace-0226/idle/
   # turns only (standard 20 new-thread, 40 same-thread and 3 long-text turns)
   PATH=/tmp/ace-0226/bin:$PATH node tools/daemon-bench/src/run.ts --entry=apps/daemon/src/cli.ts \
     --idle-ms=0 --output=/tmp/ace-0226/turns.json && mv /tmp/ace-0226/prof/* /tmp/ace-0226/turns/
   ```

   Each run writes two profiles (the layout start and the measured start); use the second. Then
   attribute every sample to the nearest stack frame whose URL is in this repository, and count it
   **transport** when that frame's file is one of behaviour.md §11's transport modules,
   `services/socket*.ts`, `services/registry.ts`, `@ace/projection`'s `wire-trim` and
   `short-deltas`, `@ace/relay`, `@ace/secure-channel` or `node_modules/ws`; **wire encoding** when
   it is `wire-encoder.ts`, `event-encodings.ts` or a `JSON.stringify` called from them. Report both
   self-attributed and inclusive (any transport frame on the stack) shares, per run, with the
   profile's sample count. A startup-only run (every phase option above set to 0) is subtracted from both. Also report `cpuMsPerTurn`, `heapUsed` and `rss` from
   the JSON outputs.

2. **Fan-out cost per subscriber**: `FANOUT_EVENTS=3000 FANOUT_ROUNDS=3 bun apps/daemon/bench/fanout.ts`
   (daemon CPU per committed event with 1, 3 and 6 subscribers; the slope is the per-subscriber
   encode and send cost).
3. **Allocation per subscriber**:
   `bun apps/daemon/bench/allocation-rate.ts --subscribers=1` and `--subscribers=6`, same
   `--events` and `--windows` (bytes allocated per 1,000 deltas, from JSC's GC log).
4. **Inbound decode**: `bun apps/daemon/bench/socket-message.ts` (CPU and allocation per inbound
   message from parsed JSON to the typed message).
5. **Latency under load**: `bun apps/daemon/bench/head-of-line.ts` for the direct and relay paths
   (`stopAck`, `sendReceipt`, event-loop gaps, deflate time), the baseline for T1 and T7.
6. **Relay and slow links**: `bun run --filter @ace/daemon bench:slow-link`,
   `bun apps/daemon/bench/relay-connect.ts` and `relay-resume.ts`, the baseline for T6.
7. **Reads**: `bun apps/daemon/bench/sqlite-store.ts --split` on an APFS clone (as ADR 0222 ran it:
   no daemon on the clone), `bun apps/daemon/bench/thread-open-bytes.ts` and
   `bun apps/daemon/bench/sidebar-live.ts`, the baseline for T4.

Each phase reruns the items its gate names with its switch off and on, interleaved (A B A B), and
reports medians with the load average.

## Counting

ADR 0226's inventory assigns each production module of `apps/daemon/src` (not `*.test.ts`, test
support, fixtures, evals or benches) to one responsibility by its path: `services/<name>.ts` by the
area its session serves, everything else by the first matching prefix rule (for example `^socket-`,
`^relay-`, `^server` → transport; `^workspace-`, `^pr-`, `^hosted-` → git and forge callers;
`^machines/`, `^transfers/`, `^parcels/` → machines), then marks it covered when an ADR's phases
name it (the CLI and doctor directories, the store's connection, writer and long-thread modules,
`engine/` and `native-engine/`, `automation-*`, the computer, locked-use and screen modules, the MCP
server's daemon modules). A builder who finds a module in the wrong group moves it in
behaviour.md §11 in the same change; the totals there and in the ADR are updated together.

## When you are done

- Every (a) file of the item passes alone with the switch on and off, on macOS, Linux and the
  Windows VM; the cross-mode list passes both ways.
- The bench items the phase names are no worse, with numbers in the PR.
- The route table, behaviour.md and the inventory say what moved.
- `cargo fmt --check`, `cargo clippy --all-targets`, `bun run check:daemon-native` and
  `bun run fmt:check` pass.
