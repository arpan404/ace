# E5.1: the engine skeleton in Rust (switch `ACE_ENGINE=native`, default off)

Part of the [engine porting guide](porting-guide.md). Its rules 1–16, "Files per work item" and
"For every E5 item" apply unchanged; where this brief is more exact, it wins. Read
[ADR 0223](../adr/0223-the-engine-and-adapters-move-to-rust-behind-the-same-interfaces.md) §4,
§5, §6 and §8 first, then the store's Task 5.5
([store guide](../store/porting-guide.md), `native/daemon/crates/ace-store/src/writer/transaction.rs`
and its shell `apps/daemon/src/native-writer/transaction.ts`).

E5.1 builds the machinery every later E5 item runs on: the switch, the local executor and its
pump, the after-commit wake queue on the store's transaction stack, the ports, the adapter
registry, the intent workers, the limits, and the `Engine` facade with every public method
declared at its final timing. It ports no thread behaviour. E5.2 to E5.10 fill in modules behind
seams this brief fixes, so they never edit E5.1's files except where a step says so.

## Decisions this brief makes

1. **No seam where Rust calls TypeScript engine modules.** With the switch on, the native engine
   owns every thread, and every behaviour it has not ported yet fails when it is reached, with
   `NativeEngineIncomplete: <what> lands in E5.<n>`. It never falls back to the TypeScript engine
   and never runs a silent no-op. Rejected: a hybrid in which a Rust executor drives the TypeScript
   actor, repository and command modules through JS ports. TypeScript `async` code cannot be
   polled by a Rust executor (it runs on JS microtasks), so every await point would move, which
   is what ADR 0223 §4 forbids (fact 3: the engine's correctness lives in where it awaits). Two
   owners of one thread's state would break priority 1 (ADR 0223 §8: one switch for all of E5),
   the cross-mode gate would test a third engine that never ships, and the hybrid seam is code
   thrown away at E5.10.
2. **Parallel items work through Rust seams E5.1 declares.** E5.1 defines the engine's shared
   state as one struct whose fields are types owned by the module files of later items (step 4),
   and the facade's binding methods as `#[napi] impl NativeEngine` blocks that each item adds in
   its own binding file (step 9). So E5.2, E5.3 and E5.4 each touch only their own files.
3. **Switch off is byte-identical.** The TypeScript engine is not edited except for the one `if`
   at the top of its constructor (step 10). The store's shell gains one field it ignores while the
   engine is off (step 3). Nothing else on the off path changes.
4. **One transaction stack per connection, shared.** Today `transactionStack()`
   (`ace-daemon-node/src/writer.rs:137`) builds a new stack on every call. E5.1 makes it return a
   handle to the one stack the connection owns, which the native engine shares (step 3).
5. **The pump never calls `setImmediate` from Rust.** `pump()` returns whether to re-arm, and the
   JS shell schedules the continuation (step 6).

## The switch

- `ACE_ENGINE=native` turns the native engine on. Unset (or any other value) is today's
  TypeScript. The value is read once in `packages/provider-kit/src/native-switches.ts:93`, as E0
  has it. Each new `Engine` asks `engineBackend()` (`:530`). Under `ACE_NATIVE_CROSS=ACE_ENGINE`
  it answers with the backend of the current boot of the event database, which the store's
  connection factory recorded (`noteDatabaseBoot`, `:448`). The store is always built before its
  engine, so the boot is known by the time the constructor asks.
- **Prerequisites, refused at module load.** Add to `native-switches.ts` a pure function beside
  `sessionSwitchRefusal` (`:187`):

  ```ts
  export function engineSwitchRefusal(input: {
    engine: boolean; // ACE_ENGINE=native
    store: boolean; // ACE_STORE=native
    writer: ReadonlySet<StoreWriterPart>; // ACE_STORE_WRITER
    cross: CrossSwitch | undefined;
  }): string | undefined;
  ```

  Let `named` be `input.engine || input.cross === "ACE_ENGINE"`. Return the first that applies:
  1. `named && !store` → `"ACE_ENGINE needs ACE_STORE=native"` (today's message, `:180`);
  2. `named && !writer.has("transactions")` → `"ACE_ENGINE needs ACE_STORE_WRITER=…,transactions"`.
     The engine shares the Rust transaction stack, which only `transactions` turns on; the prefix
     rule (`checkWriterPrefixes`) already makes `transactions` imply every part before it;
  3. `named && (cross === "ACE_STORE_WRITER" || cross === "ACE_STORE")` →
     `"ACE_NATIVE_CROSS=<cross> cannot run with ACE_ENGINE"`: a boot without the Rust stack cannot
     host the native engine.

  Call it right after `sessionSwitchRefusal`'s call and throw `new Error(message)`. Keep the
  `offender` chain (`:169`–`:180`) and its messages as they are. `ACE_CORE` is not a
  prerequisite: the Rust engine uses `ace-core` directly, never the `@ace/core` facade.
  `ACE_TRANSLATORS` and `ACE_SESSIONS` are independent: a TypeScript session reaches the native
  engine through `JsSession` (ADR 0223 §7), and translation runs wherever the session runs.

- **The addon**: the facade loads it from `sessionsAddonPath()` (`:513`), the path every native
  shell already uses. With the switch on and no file there, the constructor throws
  `ACE_ENGINE=native needs the engine addon at <path>`. No fallback.
- **The evidence line.** On the first native `Engine` a process builds, the facade appends
  `${process.pid} engine\n` to `ACE_ENGINE_EVIDENCE` when that is set, as
  `recordEvidence` does for the store (`native-writer/transaction.ts:172`–`:179`). Every
  switch-on proof run sets a fresh evidence file and fails if it is empty afterwards, so a file
  that never built a native engine cannot pass as proof. Add `ACE_ENGINE_EVIDENCE` and
  `ACE_ENGINE_ADDON` beside `ACE_SESSIONS_ADDON` in `scripts/test-home-policy.ts:121`.
- **Test**: one `test.each` table over `engineSwitchRefusal` in
  `packages/provider-kit/src/native-switches.test.ts`. Rows: each refusal alone; store and writer
  both missing (expects the store message, pinning the order); `cross: "ACE_ENGINE"` with
  `engine: false` and no store; everything present (expects `undefined`). It is new behaviour, and
  the commit says so.

## Steps

### 1. Limits (`ace-engine/src/limits.rs`)

Port `engineLimits` (`engine/limits.ts:9`–`:24`): `EngineLimits { max_active_threads: 64,
max_queued_frames: 16384, max_queued_bytes: 16 MiB, max_frame_bytes: 4 MiB, max_pending_inputs:
32, max_input_bytes: 262144 }`, overrides from the options, every value a safe integer ≥ 1, else
`EngineError::InvalidLimit` ("Invalid engine limit"). The `idleMs` check
(`index.ts:202`–`:203`, "Invalid idleMs", safe integer ≥ 0) lives here too, as
`validate_idle_ms`. The facade passes the raw numbers; Rust validates, and the binding maps the
error to the same message.

### 2. The executor (`ace-engine/src/executor.rs`)

```rust
pub enum Lane { Control, Work }

/// Posts one notification to the JS thread; implemented by the binding over the threadsafe
/// function. Called only by the party that moved the claim into Scheduled.
pub trait Notifier: Send + Sync {
    fn notify(&self) -> Notified;
}
pub enum Notified { Posted, Closing }

/// When to stop starting runnables; the binding implements it with `Instant`, tests with a
/// counter. Never a wall clock in logic (rule 9).
pub trait Budget {
    fn start(&mut self);
    fn spent(&self, started: usize) -> bool; // true after 64 runnables or 4 ms
}

/// Send + Sync: the schedule functions and producers on tokio hold it.
pub struct Shared { claim: AtomicU8, control: ConcurrentQueue<Runnable>, work: ConcurrentQueue<Runnable>, notifier: Box<dyn Notifier> }

/// !Send: lives on the JS thread with the engine state.
pub struct Executor { shared: Arc<Shared>, running: Cell<bool> }

impl Executor {
    pub fn new(notifier: Box<dyn Notifier>) -> Executor;
    /// spawn_local with a schedule function that pushes onto `lane`'s queue, then `wake()`s.
    /// Built with `async_task::Builder::new().propagate_panic(true)`, so a panicking task
    /// completes its `Task` with the panic instead of unwinding through the pump.
    pub fn spawn<T: 'static>(&self, lane: Lane, future: impl Future<Output = T> + 'static) -> Task<T>;
    /// A Send handle for producers on any thread (a session event, an I/O completion).
    pub fn waker(&self) -> ExecutorWake; // ExecutorWake::wake(&self) does the producer move
    /// One turn. Returns Rearm when the continuation must be scheduled with setImmediate.
    pub fn pump(&self, budget: &mut dyn Budget, transaction_open: &dyn Fn() -> bool) -> Pump;
}
pub enum Pump { Rearm, Done, Stale, Busy }
```

The claim is the one-claim state machine of ADR 0223 §4, as `executor.rs`'s E0 doc comment
already states. Exactly:

- **Producer** (`wake`, called by every schedule function, timer firing, session event and
  after-commit release, on any thread), after its item is pushed: CAS `Idle → Scheduled`; on
  success call `notifier.notify()`. Else CAS `Running → RunningDirty`, posting nothing. From
  `Scheduled` or `RunningDirty`, nothing. `Notified::Closing` (`napi_closing`): write one line to
  stderr (`engine pump not posted: environment closing`) and leave the claim `Scheduled`, so
  nothing posts again. The lost items are unacknowledged frames, which restart recovery treats as
  a crash's (behaviour.md §13).
- **Pump entry**: if `running` is set (a nested request: the pump was reached from inside a port
  it called), return `Stale` and change nothing; the running turn will see the work. CAS
  `Scheduled → Running`; on failure return `Stale` (a stale notification). If
  `transaction_open()` (the shared stack's `is_open`), store `Scheduled` and return `Busy`; the
  shell re-arms with `setImmediate`. The event loop already guarantees this never happens, since
  `Store.atomic` is synchronous; the check confirms it.
- **The turn**: set `running`, `budget.start()`. Loop: pop the control queue first, else the work
  queue; run the runnable inside `catch_unwind` (a panic that escapes `propagate_panic` is
  reported once and the runnable is dropped); count it; stop starting runnables when
  `budget.spent(count)`. A runnable is never cut mid-step.
- **The turn's end**: if the claim is `RunningDirty`, reset it to `Running` and keep draining
  while budget remains. With budget spent and work left, store `Scheduled` and return `Rearm`.
  With no work left, CAS `Running → Idle`; if that fails (a producer dirtied it), drain once more.
  Clear `running` on every exit path, including a caught panic (use a guard).

So at most one notification (a threadsafe call or a `setImmediate`) is ever pending, and an item
pushed at any point is drained by the running turn or finds `Idle` and posts.

Tests, in a `#[cfg(test)] mod tests` beside it (new behaviour, nothing in TypeScript covers a
claim; the commit says so): a table over (claim state, event) → (next state, notified?) for the
producer, entry and end rules; a counting `Notifier` proving that 10,000 wakes from 4 threads
during one turn post exactly one notification after it; budget exhaustion returns `Rearm` with
the control queue drained before the work queue; a nested `pump` from inside a runnable returns
`Stale`; a panicking task leaves the pump usable and its `Task` reports the panic. No sleep-based
timing anywhere.

### 3. The after-commit wake queue (`ace-store` transaction stack, shared)

Sync entries never run a task. Work they start (a wake, a spawned task) waits until the outermost
transaction commits, and is dropped if it rolls back. This replaces today's `queueMicrotask` after
the receipt (`engine/handler.ts:544`–`:545`, and `index.ts:307`, `:924`).

- **In `ace-store/src/writer/transaction.rs`** (the store's file; E5.1 adds this and nothing
  else, and a store reviewer signs it off): a second pending list beside the settlements, of plain
  `u64` tokens with the position they joined at.

  ```rust
  impl TransactionStack {
      /// Inside an open transaction: the token joins the after-commit list at the current frame
      /// and returns true. Outside one: returns false, and the caller releases at once.
      pub fn after_commit(&mut self, token: u64) -> bool;
  }
  pub struct Finish { /* existing fields */ pub released: Vec<u64>, pub dropped: Vec<u64> }
  ```

  A top-level commit moves every token to `released`, in the order they joined. A nested
  rollback (`fail_nested`, or a nested `succeed` that failed) moves the tokens that joined since
  that frame's begin to `dropped`. A top-level rollback (failed commit, `fail_top`, doomed) moves
  all of them to `dropped`. A nested release keeps them pending. Each token appears in exactly one
  of `released` or `dropped`, exactly once, ever (the same rule 5 as settlements). `finish_json`
  leaves both lists out: they never reach JavaScript. Move-the-cases rule: none to move; add the
  exactly-once table as a new test in that file's existing test module, and say so.

- **The shared stack (`ace-daemon-node/src/writer.rs`, `writer/transaction.rs`)**: the connection
  handle owns one `Rc<RefCell<StackState>>` (stack, open frames, next frame id, and an optional
  `Weak<dyn AfterCommitSink>`), created on first use. `transaction_stack()` returns a
  `NativeTransactionStack` over that same `Rc`; with the engine off there is only one caller, so
  behaviour is unchanged. After every `succeed` and `fail`, whoever called it (the JS shell's
  binding method or the engine's own `atomic`) passes `released` and `dropped` to the sink if one
  is registered, then returns. No borrow of `StackState` is held while the sink runs.
- **The sink (`ace-engine/src/executor.rs`, `AfterCommit`)**: a `HashMap<u64, Vec<Deferred>>` of
  what each token stands for (`Deferred::Wake(ThreadId, Lane)` or `Deferred::Spawn(…)`, the boxed
  future not yet spawned). `release` spawns or wakes each in token order (producer moves only);
  `drop` discards them. The engine reaches it through one function every sync entry uses:

  ```rust
  /// The only way a synchronous entry starts work: after the outermost commit, never inline.
  pub fn defer(&self, stack: &RefCell<StackState>, item: Deferred);
  ```

  It takes a fresh token, calls `after_commit`; on `false` (no transaction open) it releases at
  once, which is what `queueMicrotask` outside a transaction did. A rolled-back receipt starts
  nothing.

### 4. The engine core and its seams (`ace-engine/src/lib.rs`)

```rust
pub struct Engine { core: Rc<Core> }
pub struct Core {
    pub executor: Executor,
    pub ports: Rc<dyn Ports>,          // step 5; never reachable from State
    pub store: EngineStore,            // the connection and the shared stack, step 8
    state: RefCell<State>,
}
/// Engine state. Holds no port, no executor and no store handle, so a `with_state` closure
/// cannot call a port, spawn or await.
pub struct State {
    pub limits: limits::EngineLimits,
    pub registry: registry::Registry,
    pub workers: workers::WorkerSet,   // sends, controls, steering
    pub lifecycle: Lifecycle,          // Starting | Ready | Closing | Closed, plus flush depth
    pub actors: actor::Actors,         // E5.2
    pub repo: repository::Repo,        // E5.3
    pub commands: commands::Commands,  // E5.4
    pub sessions: sessions::Sessions,  // E5.6
    pub recovery: recovery::Recovery,  // E5.8
    pub transitions: transitions::Transitions, // E5.9
    pub liveness: liveness::Liveness,  // E5.10
    // … one field per E5 module that keeps state, each `Default`.
}
impl Core {
    /// The only way to reach state. Never re-entered: if the RefCell is already borrowed it
    /// returns EngineError::Reentrant (mapped to a JS error), it never panics.
    pub fn with_state<R>(&self, f: impl FnOnce(&mut State) -> R) -> Result<R, EngineError>;
}
#[derive(thiserror::Error)]
pub enum EngineError { InvalidLimit, InvalidIdleMs, Reentrant, NotPorted { what: &'static str, item: &'static str }, Port(PortError), Store(ace_store::Error), Closing, Starting /* … */ }
```

E5.1 adds to each module file that `State` names a `#[derive(Default)] pub struct <Name>` and the
functions the skeleton calls (below), each returning `Err(EngineError::NotPorted { … })`. Those
are declarations only, as E0's were; the owning item replaces them. E5.1 writes no other line in
those files.

The skeleton's own flow, with where each unported step fails:

- **Construction**: validate limits and `idleMs`; build the registry from the options' registry
  handle (step 7); start the 30 s idle sweep timer (`index.ts:137`–`:146`, `:210`), whose callback
  calls `recovery::prune_idle` (E5.8: `NotPorted` is reported through `onError` once per firing,
  never thrown).
- **`ready()`**: as `index.ts:466`–`:487`: if any of `recovery.preferences`, `models`,
  `providersActivated`, `resolveSilenceMs` was given, await `providersActivated` (a JS promise the
  binding turns into a oneshot), then the silence and recovery preparation (E5.6, E5.8); then
  `repository::recovery_candidates` (E5.3) in slices, and for each candidate
  `recovery::recover_thread` (E5.8); then `Ready`. On a fresh home there are no candidates, so
  once E5.3 has landed `ready()` resolves without E5.8. That is what lets E5.2 to E5.4 prove
  themselves before recovery lands. Commands before `Ready` get `engine_starting`; while closing,
  `daemon_shutting_down` (`index.ts:457`–`:460`).
- **`flush()`**: resolves when the ready promise has settled, every worker set is idle, both
  ready queues are empty and no task is running, re-checked after each wait as `index.ts:1406`–`:1426`
  loops. Each module adds its own quiescence check through one `fn quiescent(&State) -> bool` per
  module that E5.1 declares and calls (stubs return `true`, because an unported module holds no
  work).
- **`close()`**: once (`closePromise ??=`): `Closing`, cancel the sweep, then the module close
  steps in `index.ts:1428`–`:1466`'s order, each a declared function (E5.2, E5.6, E5.8 fill them),
  then a final flush, then release the threadsafe function last (step 6). Every timer the engine
  armed is cancelled before release.

### 5. Ports (`ace-engine/src/ports.rs`, binding `engine/ports.rs`, shell `native-engine/ports.ts`)

`Ports` is one trait with a method per `EngineOptions` port (`engine/engine-options.ts:14`–`:95`),
all synchronous Rust calls on the JS thread; an async port returns a `LocalBoxFuture` the binding
completes from the JS promise's `then`. E5.1 declares all of them, so later items never edit this
file. A port called with no JavaScript environment in scope (only possible from a tokio thread,
which is a bug) returns `PortError::NoEnv`; no port panics.

E5.1 itself calls these, at the points the TypeScript does:

| Port                                       | Called by E5.1 at                                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `clock.now`, `clock.setTimer` (and cancel) | every `now` the skeleton reads; the sweep timer; the timer service step 6 gives the modules. A `ManualClock` from a test works unchanged                                                                                       |
| `batchScheduler.setTimer`                  | exposed as the second timer service, for E5.2's 1 ms batch latency (`index.ts:201`); E5.1 only wires it                                                                                                                        |
| `threadId`, `commandId`, `ids`             | the id service: the given port, else the Rust port of `timeOrderedIds` (`time-ordered-id.ts:11`), same format, whose wall clock and random bytes come in from the binding (`SystemTime`, `getrandom` 0.4, already in the lock) |
| `onError`                                  | `report`; default `console.error` (`index.ts:207`), done in the shell                                                                                                                                                          |
| `providersActivated`, `waitForProvider`    | `ready()` and `ensureProvider` (`index.ts:565`–`:567`)                                                                                                                                                                         |
| `registry`                                 | step 7                                                                                                                                                                                                                         |
| `limits`, `idleMs`, `silenceMs`            | data, validated in step 1                                                                                                                                                                                                      |

Declared for later items, called where the TypeScript calls them: `transitions` (E5.9);
`recovery`, `preferences`, `previousProcessesUnverified`, `cursorPreviousProcessesGone`,
`cursorReconcileRetryMs`, `cursorFailureTimer` (E5.8); `prepareInput`, `beforeSend`,
`worktreeGit` (E5.5); `prepareWorkspace`, `assertWorkspaceAvailable`, `models`, `mcp`,
`sessionContext`, `sessionCatalog`, `agentHome`, `permissionSettings`, `resolveSilenceMs`,
`onCommandEvent`, `onSessionOpenFailure`, `onProviderDiagnostic`, `onModelUnavailable` (E5.6);
`selectInstance`, `providerEnabled`, `machine`, `onNamingPrompt` (E5.4); `aceToolAction` (E5.3);
`onSettleCleanupFailure` (E5.10).

**How a port reaches JavaScript.** The binding keeps each port as a napi `FunctionRef`. Every
entry from JavaScript (a facade method, the pump, a timer firing, a promise's `then`) installs its
`Env` in an `EnvScope` held by the binding's `JsPorts` (a `Cell<Option<Env>>`, saving the previous
value and restoring it on exit, so nested entries work), and a port call borrows it. A JS port that
throws comes back as `PortError::Threw(message, the JS error kept as a reference)`, which the
calling task handles at exactly the point the TypeScript would have caught it.

**Timers.** `setTimer` gets a JS callback the binding creates; when it fires it pushes the timer's
key onto the engine's timer queue and calls `wake()`; the waiting task runs in the next pump, never
inside the firing. Firing order is the JS clock's, so `ManualClock.advance` orders exactly as
today. What changes is that code awaiting the timer resumes in the next macrotask, not inside
`advance()` (open question 2).

### 6. The pump's driver (binding `engine/mod.rs`, shell `native-engine/engine.ts`)

- The binding creates one `ThreadsafeFunction<(), ()>` per engine, with an unbounded queue
  (`max_queue_size` 0) and errors not passed to the callee. Its JS callback is the shell's
  `pumpEntry`. `Notifier::notify` calls it `NonBlocking`; `Status::Closing` maps to
  `Notified::Closing`. With one call pending at most, `napi_queue_full` cannot happen.
- The shell:

  ```ts
  const pumpEntry = () => {
    // "rearm" covers both a spent budget and an open transaction (Busy).
    if (native.pump() === "rearm") setImmediate(pumpEntry);
  };
  ```

  `pump()` maps `Rearm` and `Busy` to `"rearm"`, `Done` and `Stale` to `"done"`. Both entries are
  Bun macrotasks; neither is ever a binding call made from inside another binding call.

- **Keeping the process alive.** The threadsafe function is `unref`'d while the engine has no
  pending facade promise and no open native session queue, and `ref`'d while it has any, so an
  engine with outstanding work keeps the process up exactly as long as that work exists, and an
  idle engine never does. Today's timers are `unref`'d (`actor.ts:39`), and this matches it
  (open question 3).
- **Release.** `close()` releases the function last (step 4). After release, `wake()` sees
  `Closing` and leaves the claim `Scheduled`.

### 7. The registry (`ace-engine/src/registry.rs`, shell over `engine/registry.ts`)

`AdapterRegistry` stays the class tests construct (`new AdapterRegistry()`, then `register`, then
pass it as `options.registry`), and registrations keep arriving after the engine is built
(enable-time discovery). With the switch on, the exported `AdapterRegistry` (`registry.ts:10`)
is a native-backed class with the same methods (rule 2: the exported name is the native one),
chosen once per instance by `engineBackend()`:

- Rust `Registry<A>` holds entries by provider and by `provider:backend`, each with the adapter
  handle `A`, its capabilities and discovery as `ace_json::Value`. The rules port as they are:
  Cursor refuses the ACP backend and defaults to `cursor-sdk` (`:13`–`:16`); `refreshDiscovery`
  applies only for the same path and version (`:30`–`:40`); `get` pins Cursor to `cursor-sdk`
  and throws the same "provider isn't ready" message (`:41`–`:52`); `has` with an identity asks
  the adapter (`:85`–`:88`); `bindSessions` and `close` visit each distinct adapter once
  (`:57`–`:84`).
- `A` in the binding is a napi reference to the JS `ProviderAdapter`; `capabilities(cli)` is
  called once at `register`, as today, so a later lookup costs no crossing. `bindSessions` calls
  the JS `bind` per entry and stores the result; `close` awaits each JS `close` and rejects with
  `AggregateError("Adapter shutdown failed")` as `:77`–`:84` does, built in the shell.
- The three `registry.test.ts` cases move to `registry.rs`'s test module (rule 4), over a Rust
  test adapter. The TypeScript file stays until its module is deleted.
- `adapters.ts` (`discoverAdapters`, `settleAll`) **stays TypeScript**: it imports the JS adapter
  packages and calls `registry.register`; nothing in it is engine behaviour, and no Rust caller
  needs it. Its three (b) cases stay with it (open question 4).

### 8. The store seam (`ace-engine/src/lib.rs` `EngineStore`, shell `native-writer/transaction.ts`)

The engine writes through the shared stack (ADR 0223 §5). E5.1 fixes the two ways its writes meet
the TypeScript shell's state, so E5.2 to E5.4 don't each invent one:

- **Inside a JS-opened transaction** (a sync entry under a receipt): events the engine appends
  must join the shell's open context. `EngineStore` calls a shell port
  `appendEvents(json)`, which parses and calls `NativeTransactions.append`
  (`native-writer/transaction.ts:104`–`:109`), so the shell's positions and `noteEvents` stay
  the only ones.
- **A transaction Rust opens at top level** (a pump step): `EngineStore::atomic(run)` begins and
  finishes on the shared stack, then hands the `Finish` JSON and the events it appended to a new
  shell method `NativeTransactions.finishForeign(finishJson, eventsJson)`, which runs exactly the
  committed or rolled-back host path of `finishTop` (`:186`–`:217`): thread cache, counters,
  read-cache eviction, WAL wake, publication to `store.subscribe`, usage listeners. It is one
  method on the shell, called only by the engine, and its first line refuses if a JS context is
  open. E5.1 builds and tests it on a step that appends no events; E5.3 is its first real user.
- A Rust transaction never resolves a frame's acknowledgement on a savepoint's release
  (ADR 0223 §4); `EngineStore` exposes `is_outermost()` and E5.2 asserts it.

### 9. The facade (`apps/daemon/src/native-engine/`, binding `ace-daemon-node/src/engine/`)

`native-engine/engine.ts` holds `class NativeEngine` with every public member of `Engine`
(`engine/index.ts:80`–`:1467`), each a one-line delegation to a function in
`native-engine/<module>.ts` (the E0 stubs; E5.1 fills them all now) that encodes arguments,
calls the binding, decodes the result and maps errors. `engine.ts` stays under 400 lines that way.
The binding struct `#[napi] pub struct NativeEngine` is in `engine/mod.rs`; each item adds its
methods in its own `#[napi] impl NativeEngine` block in `engine/<module>.rs`. The shell's
interface to the addon marks each method optional, and a missing one throws
`NativeEngineIncomplete("<method> lands in E5.<n>")`, so the facade is complete from E5.1 on and
an item lands by adding its binding block.

Kinds (behaviour.md §1): **R** synchronous read, a sync napi call returning finished JSON;
**M** synchronous mutation, committing before it returns (inside the caller's transaction if one
is open); **A** async, a promise the Rust task resolves from the pump; **H** the handler,
synchronous inside the receipt transaction; **B** binder, stores a JS callback as a port, sync.
Errors cross as the engine-api classes (`InputRejected`, `SteerTargetLost`, `AccessError`,
`SessionOpenError`) by a fixed `code` (ADR 0223 §7 rule 2).

| Member (`index.ts` line)                                                                                                                                                              | Kind                           | Rust filled by                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------- |
| `constructor` (`:159`)                                                                                                                                                                | M                              | E5.1                                                    |
| `handler`, `internalHandler` (`:83`, `:85`, built `:454`–`:476`)                                                                                                                      | H                              | E5.4                                                    |
| `guests` (`:92`), `hosts` (`:94`): facade objects over `guest-threads.ts`, `host-threads.ts`                                                                                          | R/M                            | E5.7                                                    |
| `retrySettled` (`:491`)                                                                                                                                                               | A                              | E5.10                                                   |
| `bindOwnershipFence` (`:500`); `ownershipRefusal` (`:504`); `liveMove` object (`:507`)                                                                                                | B; R; R/M                      | E5.9                                                    |
| `bindCommandPolicy` (`:519`), `bindHostInteractions` (`:819`), `bindExternalTaskStop` (`:834`), `bindDeletionPolicy` (`:1028`)                                                        | B                              | E5.4 (policy, host), E5.7 (task stop), E5.10 (deletion) |
| `ensureProvider` (`:565`)                                                                                                                                                             | A                              | E5.1                                                    |
| `providerAvailability` (`:568`), `capabilities` (`:573`, a fresh copy each call)                                                                                                      | R                              | E5.1                                                    |
| `supportsSteering` (`:577`), `messageFacts` (`:581`)                                                                                                                                  | R                              | E5.5                                                    |
| `prioritizeSubagentResult` (`:591`)                                                                                                                                                   | M                              | E5.4                                                    |
| `spawn` (`:599`), `admitCreation` (`:1095`), `creationPending` (`:1092`)                                                                                                              | M; M; R                        | E5.4                                                    |
| `access` (`:647`), `targetInstance` (`:664`), `childAccess` (`:676`), `offeredModes` (`:690`), `childPermissionRefusal` (`:704`)                                                      | R                              | E5.7                                                    |
| `attachChild` (`:717`), `updateChild` (`:720`), `machineChild` (`:725`), `transferHold` (`:732`), `externalHold` (`:745`), `delegationStarted` (`:785`), `delegationSettled` (`:788`) | M                              | E5.10                                                   |
| `machineHandoff` (`:774`); `adoptMachineHandoff` (`:782`)                                                                                                                             | R; M                           | E5.9                                                    |
| `workload` (`:792`), `providerProcesses` (`:805`)                                                                                                                                     | R                              | E5.2 (backlog), E5.6 (processes)                        |
| `backgroundPorts` (`:826`): an object over three sync calls                                                                                                                           | R/M                            | E5.6                                                    |
| `rootAgent` (`:853`, may apply a tick), `activeRun` (`:862`), `turnOrigin`, `delegationsInFlight` (`:866`–`:867`), `aceCaller` (`:869`), `withinAgent` (`:874`)                       | R (rootAgent M)                | E5.2, E5.5                                              |
| `openHostApproval` (`:878`), `hostError` (`:889`), `hostNotice` (`:893`), `resolveHostApproval` (`:896`), `closeHostGate` (`:910`)                                                    | M                              | E5.7                                                    |
| `discardRecovery` (`:914`), `cancelRecovery` (`:918`), `captureContinuation` (`:927`)                                                                                                 | M                              | E5.8                                                    |
| `cancelDelegatedInputs` (`:921`)                                                                                                                                                      | M (its wakes deferred, step 3) | E5.4                                                    |
| `changeWorkspace` (`:930`)                                                                                                                                                            | A                              | E5.9                                                    |
| `reconcileThread` (`:965`), `reconcileOwn` (`:970`)                                                                                                                                   | A                              | E5.10                                                   |
| `hasSession` (`:975`), `hasState` (`:983`)                                                                                                                                            | R                              | E5.6; E5.3                                              |
| `cleanupThreads` (`:986`), `liveWork` (`:989`), `runsProviderWork` (`:993`), `hasUnfinishedWork` (`:1016`)                                                                            | R                              | E5.10                                                   |
| `stopForDeletion` (`:997`), `cleanupSession` (`:1020`), `stopForCancellation` (`:1024`)                                                                                               | A                              | E5.10                                                   |
| `forgetPurged` (`:1004`), `prepareDeletion` (`:1031`)                                                                                                                                 | M                              | E5.10                                                   |
| `setSilenceMs` (`:1034`), `clearWorkspaceSilenceMs` (`:1046`)                                                                                                                         | M                              | E5.6                                                    |
| `liveThreadIds` (`:1049`)                                                                                                                                                             | R                              | E5.2                                                    |
| `continueImported` (`:1052`)                                                                                                                                                          | A                              | E5.8                                                    |
| `sessionMetadata` (`:1072`)                                                                                                                                                           | R                              | E5.6                                                    |
| `commandFailure` (`:1076`), `commandExecution` (`:1079`), `queuePage` (`:1082`), `queue` (`:1146`), `inputFate` (`:1135`)                                                             | R                              | E5.4                                                    |
| `retainsAttachment` (`:1085`), `readRawBlob` (`:1402`, bytes, not JSON)                                                                                                               | R                              | E5.3                                                    |
| `ready` (`:1088`), `flush` (`:1406`), `close` (`:1428`)                                                                                                                               | A                              | E5.1                                                    |
| `prepareCommand` (`:1111`)                                                                                                                                                            | A                              | E5.4                                                    |
| `admissionReopened` (`:1150`), `accountRecovered` (`:1213`)                                                                                                                           | M                              | E5.4; E5.8                                              |
| `resuming` (`:1155`), `endedOnLimit` (`:1162`), `treeActive` (`:1176`), `limitContinues` (`:1183`), `heldInterrupted` (`:1196`), `limitsMatter` (`:1204`)                             | R                              | E5.8                                                    |
| `onLimitPolicy` (`:1193`)                                                                                                                                                             | B (returns an unsubscribe)     | E5.8                                                    |

The builder checks this list against `index.ts` before writing: any public member it finds that is
not here joins the table with its kind, in the same commit. The handler keeps today's shape in the
shell: `store.atomic(() => fenceCommand ?? hostInteraction?.(command) ?? policy(command, accept))`
where every engine step is a sync binding call, so the JS policies run in JS inside the same
transaction and the binding never calls a policy from inside its own borrow; `sessions.commanded`
(`:474`) runs after the receipt, as a binding call.

### 10. The one `if` (`engine/index.ts`)

At the top of `Engine`'s constructor (`:159`, before `this.waitForProvider = …`):

```ts
if (engineBackend() === "native") return nativeEngine(store, options) as unknown as Engine;
```

A constructor may return an object, so `new Engine(store, options)` in all 205 files gets the
facade with no change. `nativeEngine` is the one trusted cast of a value ace built (ADR 0125).
Field initializers run before the constructor body, so check each has no effect worth keeping
off: `reconciles` (`:121`, builds an object, arms nothing), `liveMove` (`:507`, closures only),
`turnOrigin`/`delegationsInFlight` (`:866`–`:867`), the `actors`/`pendingSettles`/`deferredWakes`
collections. None arms a timer or subscribes; the reviewer confirms, since the first that did
would leak with the switch on. Nothing in the daemon uses `instanceof Engine` (checked); keep it
that way.

### 11. Workers (`ace-engine/src/workers.rs`)

Port `IntentWorkers` (`engine/workers.ts:4`–`:49`) as `Workers { lane, tasks: HashMap<ThreadId,
Task<()>>, rerun: HashSet<ThreadId>, stopped }`: `wake` spawns once per thread on its lane and
marks a rerun if already running; the task loops `rerun.remove; run(id).await` while rerun and
not stopped; on finish it removes itself and wakes again if a rerun was set after the loop's last
check (`:24`–`:27`); errors go to `report`. `is_active`, `drain(id)`, `active`, `flush`, `stop` as
there. `controls` uses `Lane::Control`; `sends` and `steering` use `Lane::Work`. The worker map
is reached only through `with_state`; the spawn itself happens outside the closure. `run` is a
function pointer the owning item supplies (E5.4 sends, E5.5 steering, E5.10 controls); until then
`run` returns `NotPorted`, reported once per wake. `workers.ts` has no test file; no cases move.

## Re-entrancy rules (every `#[napi]` method and every port)

1. Every `#[napi]` method on `NativeEngine` takes `&self` and holds only `Rc<Core>`; none takes
   `&mut self`, because a port can call back into the engine while the outer call is on the
   stack.
2. State is reached only through `with_state`, whose closure gets `&mut State` and nothing else:
   no port, executor or store. So no borrow is ever held across a port call, a spawn or an
   await, and a nested `with_state` cannot happen. If it is ever attempted, `with_state` returns
   `EngineError::Reentrant` (a JS error naming the method), never a panic.
3. A port that needs data from state copies it out first, calls the port with no borrow, then
   re-enters `with_state` and re-checks what it read (generation, lifetime, `holdToken`), as
   the TypeScript re-checks after an await. Example: `aceCaller(threadId, tool, matches)` reads
   the live calls, then calls `matches` per call outside the borrow.
4. A port that calls back a **sync** member gets a sync entry; its borrow is free. A port that
   calls an **async** member gets a promise and a spawned task; the task never runs inline, it
   runs in the next pump (the claim goes `Running → RunningDirty` if a turn is in progress).
5. The pump is never re-entered: a nested `pump()` returns `Stale` (step 2). A sync entry may
   open a transaction from inside a port called during a pump step; it nests as a savepoint on
   the shared stack, which is the design.
6. Every `#[napi]` export uses `catch_unwind` (rule 7). A panic inside a task is caught by
   `propagate_panic` and ends that task; E5.2 decides what it poisons (`actor.ts:271`).
7. Nothing on the JS thread waits synchronously for a tokio task, a lock held by tokio, or a
   promise.

## Proof

Correction to the guide's E5 table: `engine.process` and `main-integration.process` cannot be the
first green "with E5.2 to E5.4". Every test in `engine.process.test.ts` opens a session and sends
(`:23` translates provider frames, `:207` closes an idle session, `:227` is startup recovery,
`:139` resolves an interaction) and every test in `main-integration.process.test.ts` delivers to a
scripted session or restarts (`:85` restart continues natively). They need delivery (E5.5),
sessions (E5.6), approvals (E5.7) and restart (E5.8). They are the first green **at E5.8**; until
then they fail with `NativeEngineIncomplete`, which is the expected result and names the item.

What E5.1 alone proves:

- **Switch off, byte-identical**: each file alone, unchanged and passing:
  `engine/engine.process.test.ts`, `engine/main-integration.process.test.ts`,
  `engine/registry.test.ts`, `engine/adapters.test.ts`,
  `packages/provider-kit/src/native-switches.test.ts`, and the store's Task 5.5 proof list with
  `ACE_STORE=native ACE_STORE_WRITER=fold,sequences,events,columns,live,transactions` (the shared
  stack and the two new `Finish` lists must change nothing there).
- **Rust**: `cargo test -p ace-engine` (executor, workers, limits, registry cases moved) and
  `cargo test -p ace-store` (the after-commit exactly-once table).
- **Switch on, what exists**: `engine/registry.test.ts` with the switch on runs the native
  `AdapterRegistry` (it builds no engine, so no evidence line is expected from it); the refusal
  table; and a reviewer's `bun -e` check, written into the PR, that builds an `Engine` on a fresh
  temp home with every prerequisite set, then `ready()`, `capabilities`, `providerAvailability`,
  `flush()` and `close()` succeed and the evidence file has exactly one line. From E5.2 on, every
  switch-on run of a file that builds an `Engine` must leave a non-empty evidence file.
- **What E5.2 to E5.4 add**: with them, the commands row files that open no session (E5.4's list)
  and the storage row (E5.3) go green with the switch on; each item names its files.

```sh
f=apps/daemon/src/engine/registry.test.ts
test -f "$f" && bun --bun x vitest run "$f" --maxWorkers=4
test -f "$f" && ACE_STORE=native ACE_STORE_WRITER=fold,sequences,events,columns,live,transactions \
  ACE_ENGINE=native bun --bun x vitest run "$f" --maxWorkers=4
```

## Benches and the cross-mode run

- E5.1 cannot run `bench/head-of-line.ts` with the switch on (no send exists yet). It records the
  **switch-off baseline** on the machine later items will use: `bun apps/daemon/bench/head-of-line.ts
  --runs=3`, reporting `stopAck` and `sendReceipt` p50, p99 and max under each bulk (`live`
  first) and the event-loop delay from `head-of-line-daemon.ts`, plus
  `bun apps/daemon/bench/scripted.ts`, into the PR. E5.8 runs both with the switch on against
  this baseline, and default-on needs no regression in any of the six figures (ADR 0223 §8).
- The pump's own cost: report one figure from the executor tests' counting run (runnables per
  millisecond through `pump` with a no-op future), so a later regression in the executor shows.
  No new bench file.
- The E5 cross-mode list (ADR 0223 §8) needs restart, so its first run is E5.8's. E5.1 checks
  only that `ACE_NATIVE_CROSS=ACE_ENGINE` with the prerequisites passes the refusal and that two
  boots of one home get opposite `engineBackend()` answers (the existing switch tests).

## Files (all yours; nothing else)

- `native/daemon/crates/ace-engine/src/{lib,executor,ports,registry,workers,limits}.rs`, and the
  declaration-only additions of step 4 in the other module files.
- `native/daemon/crates/ace-store/src/writer/transaction.rs` (step 3's list only).
- `native/daemon/crates/ace-daemon-node/src/engine/{mod,ports,js_session}.rs` and
  `writer.rs`/`writer/transaction.rs` for the shared stack. `js_session.rs` in E5.1 holds only the
  `JsSession` type and its error mapping (`instanceof SteerTargetLost` first, then `InputRejected`,
  ADR 0223 §7 rule 2); E5.6 opens sessions through it.
- `apps/daemon/src/native-engine/{engine,ports}.ts` and the facade functions in
  `native-engine/<module>.ts`; the one `if` in `engine/index.ts`; the native `AdapterRegistry`
  choice in `engine/registry.ts`; `finishForeign` and `appendEvents` in
  `native-writer/transaction.ts`; `engineSwitchRefusal` and its table in `native-switches.ts`
  and its test; `scripts/test-home-policy.ts`.
- Every file under 400 lines; none over 1,500 (`bun run check:size`). Split `executor.rs` into
  `executor/{claim,pump,after_commit}.rs` if it grows past 400.
- `ace-engine/Cargo.toml`: drop `serde_json` (rule 8: JSON goes through `ace-json`) and add
  `ace-json`; nothing else new.

## Must not

- Port any thread behaviour, or make an unported path succeed silently.
- Call a TypeScript engine module from Rust, or keep a TypeScript `Engine` alive beside a native
  one.
- Run a runnable outside `pump`, or start a task from a sync entry except through `defer`.
- Change the store's stored formats, `engineSchemaVersion` 9, or `finish_json`'s output.
- Run the full suite, `bun run check`, `test:process` or any tier; one file at a time (rule 3).

## Reviewer checks

- The claim table matches ADR 0223 §4 move for move; `notify` is called only after a successful
  `Idle → Scheduled`; `Closing` leaves `Scheduled`.
- The control queue drains before the work queue every turn; the budget is 64 runnables or 4 ms.
- `with_state`'s closure type admits no port, executor or store; no `&mut self` on `NativeEngine`.
- A token is released or dropped exactly once; a rolled-back receipt's wake never runs (make one
  table row fail by moving `dropped` to `released`).
- With the switch off, `git diff origin/ace/daemon-rust-rewrite -- apps/daemon/src/engine` shows
  only the one `if` and the registry choice.

## Open questions for the owner

1. **Unported paths fail at the call, not at boot.** With `ACE_ENGINE=native` before E5.10, the
   daemon starts and a call into an unported module throws `NativeEngineIncomplete`. The other
   choice is refusing to start until every item has landed, which would stop E5.2 to E5.4 from
   proving anything with the switch on. _Recommended: fail at the call; the switch stays
   undocumented and default-off until E5.10, so no person meets a half engine._
2. **Code awaiting a timer resumes in the next macrotask.** A `ManualClock.advance()` (or
   `systemClock` timer) fires in today's order, but the native task resumes in the next pump, not
   inside `advance()`. A test that reads state synchronously after `advance()` without awaiting
   would see the difference. _Recommended: accept, as ADR 0223 §4 already does ("a timer firing
   is a producer like any other"); a file that breaks on it is reported, not edited._
3. **Process liveness.** The threadsafe function is `ref`'d only while a facade promise is pending
   or a native session queue is open. ADR 0223 §7 rule 5 says it stays referenced until every
   session queue is closed, which this keeps; it adds pending promises so a test awaiting
   `engine.flush()` with only native work outstanding doesn't exit early. _Recommended: accept._
4. **`adapters.ts` stays TypeScript.** The guide lists its (b) cases to move, but the module
   only constructs JS adapters and registers them; no Rust code replaces it. _Recommended: it stays
   until adapters themselves are native, and the guide's E5.1 row drops `adapters` from the cases
   to move._
5. **Editing the store's transaction stack.** The after-commit list goes into `ace-store`'s
   `TransactionStack` (store Task 5.5's file), not into a parallel structure in the engine, so one
   stack decides commit and rollback for both settlements and wakes. _Recommended: accept, with a
   store reviewer on that commit._
6. **`finishForeign`: Rust-opened transactions publish through the JS shell.** Until the store's
   publication moves to Rust, a top-level transaction the engine opens hands its `Finish` and
   events to the shell to publish, costing one JSON crossing per step commit. _Recommended:
   accept and measure it in E5.3 with `bench/sqlite-store.ts --split`; it disappears when
   publication is native._
