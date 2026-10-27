# Android multi-machine runtime foundation

One SDK runtime per paired computer, mirroring the iOS `MachinesModel` /
per-machine `ClientModel` lifecycle (`apps/ios/Sources/Models/`) without
copying it. Directory rules and credential storage stay where they are:
`../pairing/machines.ts` owns the shared `MachineDirectory`, and the
`CredentialStore` owns device tokens. This module only owns runtime
lifecycle: which machines run, when they stop, and whose callbacks count.

## Rules

- **Per-machine isolation.** `makeRuntime(entry)` builds one runtime with its
  own `Client` and its own per-machine `Storage` namespace (outbox plus
  immutable host binding, one owner per daemon/device namespace as in
  `../storage.ts`). A runtime or storage object is never shared between
  entries. One machine's start failure is recorded under `failure()` and
  never stops or closes another machine.
- **Serialized lifecycle.** Every mutation runs on one tail, like the
  directory. A replacement closes the old runtime before the new one opens,
  so two runtimes never own one Storage namespace at once; a removal closes
  the runtime before the directory entry goes, so the outbox database is
  never deleted underneath its owner. A close failure keeps the old runtime
  attached and rethrows before anything else is touched, so the manager
  never strands a live runtime it can no longer close and never opens a
  duplicate beside it. A failed replacement re-opens the previous binding
  when it can, so one bad target does not drop a healthy machine; the
  replacement error is still thrown and recorded under `failure()`. A failed
  directory removal reconnects the machine and rethrows the directory error,
  even when the reconnect also fails.
- **Stale callbacks stop.** Each machine's runtime carries a monotonic
  epoch, bumped on every successful open, disconnect and removal. Native
  socket events must capture `epochOf(hostId)` at open and check
  `isCurrent(hostId, epoch)` before touching the new owner. The epoch map is
  append-only for the life of the manager: epochs are never removed or
  reset, so a stale epoch can never become current again (no ABA). A
  directory failure keeps every running runtime; a refresh that changes
  nothing restarts nothing; a rename keeps its runtime while a new target or
  device binding replaces it.
- **Fan-out never crosses machines.** `setOnline` and `wake` run over a
  point-in-time snapshot and isolate each runtime's throw, so one broken
  machine cannot block connectivity or wake delivery to the others.
- **Fail-closed production.** `failClosedRuntime` throws
  `ProductionTransportError` before any socket, fetch or credential is
  touched. Pass it as `makeRuntime` until the native bridge is available;
  once it is, pass `createProductionMakeRuntime`
  (`./production-runtime.ts`). The React Native default
  WebSocket/fetch must never carry pairing material, and
  `index.production.tsx` stays unpaired until its UI wiring lands.

## Integration needs

Production wiring has landed; UI consumption is later work:

1. Production `makeRuntime`: `createProductionMakeRuntime`
   (`./production-runtime.ts`) builds one SDK `Client` per entry over the
   native pinned WSS adapter (`bridgeSocketTransport` in
   `../security/expo-bridge.ts` plus the `pinnedSocketOpen/Send/Close`
   bridge in `modules/ace-native`), with `expectedHostId`/`deviceId` pinned
   to the entry, per-entry `sqliteNamespace` outboxes
   (`../storage.ts`, scope `JSON.stringify([hostId, deviceId])`, tables
   ensured once at startup), and a credential closure that re-reads the
   device token on every attempt and exchanges a fresh single-use ticket
   (`../pairing/tickets.ts`) per connection over `ticketFetch` with the
   machine's `TrustMonitor`: a native pin refusal reports to that monitor
   and surfaces as `auth` so routing still sees the pin mismatch instead
   of generic offline. The monitor is scoped by machine identity (host
   confirmed pin plus device): a re-pair with a new pin or device mints a
   fresh monitor, and removal plus directory prune drop it. Neither a ticket
   success nor a socket `open` ever clears a failure: on a `*.ts.net` host
   the native layer may accept the Tailscale system certificate with a
   mismatched pin (ADR 0097), and the bridge reports no which-path signal,
   so success cannot prove the pin matched. This is stricter than iOS, which
   clears its monitor when the SDK connection reaches `ready`. Ticket abort
   stops waiting but cannot cancel the native request: the abort maps to
   `offline` downstream, so the SDK keeps retrying with backoff like any
   offline failure, and a late native success after the abort leaves the
   failure untouched. `Client.close` stops those retries (the epoch guard
   drops the late credential and the closed flag blocks reconnect and wake).
   A late socket `open` after close or replacement delivers nothing.
   Relay targets and malformed pins throw before any
   socket, fetch or credential is touched.
2. Keystore adapter (`../pairing/keystore.ts`, production entry
   `../pairing/secure-store.ts`) is taken as a dependency, so revocation
   and re-pairing take effect through the shared removal ordering.
   `createProductionStartup` (`./production-startup.ts`) assembles it with
   the directory; production passes the Keystore-backed store.
3. App startup wiring (A02.08): `createProductionStartup` loads the
   directory, builds the manager with epoch-bound `beforeConnect` and
   namespace/grant cleanup on removal, routes `setOnline`/`wake` from app
   lifecycle and network state, and keeps the fixture runtime debug-only.
   The pairing/inbox screens that drive `startup.pair`/`startup.route` are
   still open, so `index.production.tsx` stays unpaired.
4. Inbox merging across machines (M04) and pending-read bounds (A03.06) are
   later work that consumes this manager. Grant admission helpers exist at
   this boundary (`GrantStore` / `assertCanOperate` / `ViewOnlyError` plus
   `startup.canOperate(hostId)` / `startup.assertCanOperateFor(hostId)` /
   `startup.runtimeForMutation(hostId)`): unknown hosts, known hosts with no
   recorded grant row, and every host when the persisted file is malformed
   read as view-only, mirroring the iOS `ClientModel.canOperate` rule except
   unknown/missing grants stay view-only where iOS defaults them to operate.
   `runtimeForMutation` returns a fresh short-lived lifecycle gate per call,
   never the shared runtime: every gate method re-resolves the grant and the
   live runtime, so a cached gate fails after revocation, disconnect or
   removal. This is not an enforced content-mutation boundary: the app's real
   inbox/composer mutations are not yet routed through the gate and
   `manager.client` remains directly reachable, so view-only enforcement is
   not demonstrable end to end. No production UI is wired through these
   helpers, so `index.production.tsx` stays an unpaired shell and production
   stays unwired and fail-closed.

## Verification

`machines-runtime.test.ts`: 23 tests on injected fakes (no device, socket
or daemon). Covered: concurrent machines with isolated runtimes, failure
isolation, no-op refresh, rename-keeps versus target/device-replaces,
overlapping replacements leaving only the latest attached, removal ordering
(close before directory remove, then detach and `afterRemove`), failed
removal reconnecting, dropped listings stopping only that runtime, directory
failure keeping runtimes, `disconnectAll`, connectivity/wake fan-out, the
fail-closed factory, plus the lifecycle hardening: close failures keeping
the single owner attached (replacement, removal, disconnect, reconcile,
`disconnectAll` with `AggregateError`), failed replacements rolling back to
the previous binding, directory errors never masked by reconnect failures,
per-runtime fan-out isolation, and epochs never reused. Run with
`bunx vitest run apps/android/src/runtime --project unit`.
