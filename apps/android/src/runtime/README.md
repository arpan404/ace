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
  touched. Pass it as `makeRuntime` until the production runtime wiring
  below lands (native pinned WSS behind `makeRuntime`, Keystore store
  behind the directory, app startup). The React Native default
  WebSocket/fetch must never carry pairing material, and
  `index.production.tsx` stays unpaired.

## Integration needs (open)

1. Production `makeRuntime`: one SDK `Client` per entry over the native
   pinned WSS adapter (`../security/pinned-transport.ts` policy plus the
   `pinnedSocketOpen/Send/Close` bridge in `modules/ace-native`), with
   `expectedHostId`/`deviceId` pinned to the entry, per-entry
   `sqliteOutbox` namespaces, and a credential closure that re-reads the
   device token on every attempt and exchanges a fresh single-use ticket
   (`../pairing/tickets.ts`) per connection. Nothing here creates that
   wiring.
2. Keystore adapter (`../pairing/keystore.ts`, production entry
   `../pairing/secure-store.ts`) wired behind the directory, so revocation
   and re-pairing take effect through the shared removal ordering.
3. App startup wiring (A02.08): load the directory, build this manager,
   route `setOnline`/`wake` from app lifecycle and network state, and keep
   the fixture runtime debug-only.
4. Inbox merging across machines (M04), per-machine grant guards (A03.05)
   and pending-read bounds (A03.06) are later work that consumes this
   manager; they are not implemented here.

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
