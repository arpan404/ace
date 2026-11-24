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
declared at its final timing, and the test seam (step 12) through which every E5 item shows a
native result as it lands. It ports no thread behaviour. E5.2 to E5.10 fill in modules behind
seams this brief fixes, so they never edit E5.1's files except where a step says so.

Revised 2026-11-24 after review (gpt-6.2-sol): the claim is a CAS loop (step 2), Rust-opened
transactions share the shell's context from their begin (step 8), wakes are released after the
shell's settlement and publication (step 3), the pump bounds controls (step 2), shutdown and
self-waits are defined (step 4), the registry stays backend-neutral (step 7), and the owner's six
decisions are recorded at the end.

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
   at the top of its constructor (step 10) and a change listener on the registry that nothing
   subscribes to while the engine is off (step 7). The store's shell splits `transaction` into
   its open and close halves (step 8) and calls an empty wake release (step 3); the off path runs
   the same statements in the same order.
4. **One transaction stack per connection, shared.** Today `transactionStack()`
   (`ace-daemon-node/src/writer.rs:137`) builds a new stack on every call. E5.1 makes it return a
   handle to the one stack the connection owns, which the native engine shares (step 3).
5. **The pump never calls `setImmediate` from Rust.** `pump()` returns whether to re-arm, and the
   JS shell schedules the continuation (step 6).
6. **One transaction context, whoever opens.** A transaction Rust opens goes through the same
   shell context as one JavaScript opens, from before its body runs to after its last step
   (step 8). There is no post-hoc hand-over of a finished transaction.
7. **Binders always work.** Every member that stores a JS callback (`bind*`, `onLimitPolicy`) is
   implemented in E5.1 as a stored port, because production binds at boot
   (`services/engine.ts:575` binds the ownership fence). Only the code that _uses_ the callback
   waits for its item.

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
  that never built a native engine cannot pass as proof. Add `ACE_ENGINE_EVIDENCE` beside
  `ACE_SESSIONS_ADDON` in `scripts/test-home-policy.ts:121`. There is no `ACE_ENGINE_ADDON`: the
  engine lives in the one addon, found the way every native shell finds it.
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
pub struct Shared {
    claim: AtomicU8,
    closed: AtomicBool,
    /// External items (session events, I/O completions, timer firings, after-commit releases).
    /// `ConcurrentQueue::close()` closes admission atomically: a push after it fails.
    inbox: ConcurrentQueue<Item>,
    /// Runnables of tasks already spawned; stay open until `shut`, so the shutdown drain runs.
    control: ConcurrentQueue<Runnable>,
    work: ConcurrentQueue<Runnable>,
    notifier: Box<dyn Notifier>,
}

/// !Send: lives on the JS thread with the engine state.
pub struct Executor {
    shared: Arc<Shared>,
    running: Cell<bool>,
    current: Cell<Option<TaskId>>,
    /// Consecutive control polls since the last work poll, saturating at 8. Executor state, not
    /// per turn: it survives the end of a turn, so the fairness rule holds when every turn ends
    /// after one poll, and it never grows past 8.
    control_streak: Cell<u8>,
    /// Set by `close_admission`; the pump signals `drained` at the end of the first turn that
    /// finds the inbox and both run queues empty and the join predicate the close task passed
    /// (no admitted batch unacknowledged) true. Close's overall 4.5 s deadline cuts it short.
    draining: Cell<Option<oneshot::Sender<()>>>,
}

impl Executor {
    pub fn new(notifier: Box<dyn Notifier>) -> Executor;
    /// spawn_local with a schedule function that pushes onto `lane`'s queue, then `wake()`s.
    /// Built with `async_task::Builder::new().propagate_panic(true)`, so a panicking task
    /// completes its `Task` with the panic instead of unwinding through the pump. The builder's
    /// metadata carries the task's `TaskId`, which the pump puts in `current` while it polls.
    pub fn spawn<T: 'static>(&self, lane: Lane, future: impl Future<Output = T> + 'static) -> Task<T>;
    /// A Send handle for producers on any thread (a session event, an I/O completion).
    /// `ExecutorWake::push(item)` pushes onto the inbox, then does the producer move; after
    /// admission has closed it returns `Refused` and pushes nothing.
    pub fn waker(&self) -> ExecutorWake;
    /// The task being polled now, if any (for barriers that must not wait on their caller).
    pub fn current(&self) -> Option<TaskId>;
    /// One turn. Returns Rearm when the continuation must be scheduled with setImmediate.
    pub fn pump(&self, budget: &mut dyn Budget, transaction_open: &dyn Fn() -> bool) -> Pump;
    /// Shutdown, first step: closes the inbox (no external producer can enqueue from here on)
    /// and returns a receiver the pump completes when everything admitted has run.
    pub fn close_admission(&self) -> oneshot::Receiver<()>;
    /// Terminal: no runnable is accepted or run again; queued runnables are dropped (their tasks
    /// cancel). Called by the close task after the drain, before the threadsafe function goes.
    pub fn shut(&self);
}
pub enum Pump { Rearm, Done, Stale, Busy }
```

The claim is the one-claim state machine of ADR 0223 §4 (`:240`–`:252`), as `executor.rs`'s E0
doc comment states. Every move is a `compare_exchange` that, on failure, **retries against the
state it observed**; no rule is two fixed CAS attempts. Exactly:

- **Producer** (`wake`, called by every schedule function, timer firing, session event and
  after-commit release, on any thread), after its item is pushed (`SeqCst` push and claim
  operations throughout, so the push is visible to whoever wins the claim):

  ```rust
  let mut seen = claim.load(SeqCst);
  loop {
      let next = match seen { Idle => Scheduled, Running => RunningDirty, Scheduled | RunningDirty => return };
      match claim.compare_exchange(seen, next, SeqCst, SeqCst) {
          Ok(_) => { if next == Scheduled { post() } return }
          Err(now) => seen = now, // e.g. saw Running, the pump moved to Idle: retry, and post
      }
  }
  ```

  The case this loop exists for: the producer pushes, sees `Running`, and before its CAS the pump
  (which found the queues empty before the push) moves `Running → Idle`. The CAS fails with `Idle`
  observed, the loop retries `Idle → Scheduled`, and posts. Two fixed attempts would lose that
  item's notification. An external producer pushes onto the inbox first; if the inbox is closed
  the push fails, it returns `Refused`, and it does not touch the claim (step 4). With `closed`
  set, a task waker returns before the loop.
  `post()` is `notifier.notify()`. On `Notified::Closing` (`napi_closing`, ADR 0223 `:263`): write
  one line to stderr (`engine pump not posted: environment closing`) and leave the claim
  `Scheduled`, so nothing posts again.

- **Pump entry**: if `running` is set (the pump was reached from inside a port it called), return
  `Stale` and change nothing; the running turn sees the work. CAS `Scheduled → Running`; on
  failure return `Stale` (a stale notification). If `transaction_open()` (the shared stack's
  `is_open`), store `Scheduled` and return `Busy`; the shell re-arms. The event loop already
  guarantees this never happens, since `Store.atomic` is synchronous; the check confirms it.
- **The turn**: set `running`, `budget.start()`. The turn has two phases with separate shares
  of its budget, so neither can use up the other's:
  1. **Intake**: move at most **32 inbox items** to their tasks (each wakes or spawns, which is
     cheap and polls nothing), and stop early once 2 ms of the turn have gone. Items beyond that
     stay in the inbox for the next turn, which the turn's end re-arms for. An inbox that stays
     full therefore costs each turn at most 32 moves and half the time budget.
  2. **Polling**: the rest of the turn, up to 64 polls and 4 ms from the turn's start, is for
     runnables. Whenever a run queue is non-empty at the start of this phase, at least one
     runnable is polled, even if intake used its whole share. Pick each by the **fairness rule**:
     the control queue first, except that when `control_streak` is 8 and the work queue is
     non-empty, the next poll is a work runnable. A control poll sets the streak to
     `min(streak + 1, 8)` (it saturates, so it never grows without limit); a work poll sets it to
     0; a turn's end leaves it as it is. A per-turn counter would never reach 8 if every turn's
     budget ran out after one slow control, and work would starve. So controls keep priority (a
     Stop's interrupt is never behind bulk work), and neither a control flood nor a full inbox can
     starve work.

  Poll each runnable with `current` set to its task and inside `catch_unwind` (a panic that
  escapes `propagate_panic` is reported once and the runnable is dropped); count it; stop
  starting runnables when `budget.spent(count)`.

- **One poll may exceed 4 ms.** `setImmediate` yields to I/O between turns, but the budget is
  checked between polls, never inside one, so a turn can overrun by one poll. What bounds a poll
  is design (ADR 0223 §4 "Responsiveness", `:255`: a step commits at most once, no history-sized
  work, frame batches ≤ 256 frames or 256 KiB), not the budget. The binding keeps the longest poll
  of each turn and a count of polls over 16 ms; the bench reports both (Benches). No tighter
  bound is promised.
- **The turn's end**, also a loop over the observed state:
  - work left (a run queue or the inbox) and budget remaining: keep draining, intake share
    included;
  - budget spent (whether the claim reads `Running` or `RunningDirty`): `swap(Scheduled)` and
    return `Rearm`. A producer that dirtied the claim posted nothing, and the continuation covers
    its item; a producer that now sees `Scheduled` does nothing;
  - no work left: CAS `Running → Idle`. If it fails with `RunningDirty` observed, store `Running`
    and drain again (budget permitting, else the budget-spent rule). On success return `Done`.

  Clear `running` and `current` on every exit path, including a caught panic (a guard).

So at most one notification (a threadsafe call or a `setImmediate`) is ever pending, and every
pushed item is drained by the running turn or posted by its producer.

Tests, in a `#[cfg(test)] mod tests` beside it (new behaviour; nothing in TypeScript covers a
claim, and the commit says so). The claim's moves are pure functions over an `AtomicU8`, so the
interleavings are written as explicit sequences on one thread, with no sleeps:

- "a wake that sees Running while the pump goes idle still posts": pump finds the queues empty →
  producer pushes and loads `Running` → pump CASes `Running → Idle` → the producer's CAS fails
  with `Idle`, retries, posts exactly once; the next entry runs the item.
- "a wake during the last runnable of a spent budget runs next turn": the producer dirties the
  claim during the 64th poll → `Rearm`, the claim reads `Scheduled`, no notification was posted,
  and the re-armed entry runs the item.
- "an empty end that finds the claim dirtied drains again" and "a stale entry changes nothing".
- A table over (state, event) → (next state, posted?) for producer, entry and end.
- A counting `Notifier`: 10,000 wakes from 4 threads during one turn post at most one
  notification, and every item runs.
- Fairness: 100 queued controls and 1 work runnable: the work runnable runs within the first 9
  polls; with no work queued, controls run back to back.
- "work runs even when every turn ends after one slow control": a `Budget` that is spent after
  every poll, 20 queued controls and 1 work runnable; the work runnable runs in the 9th turn.
  A counter reset per turn makes this fail.
- "a producer racing shutdown is refused once admission closes": a thread pushes through
  `ExecutorWake` in a loop while `close_admission` runs; every push that returned `Accepted` is
  run before `drained` completes, every later push returns `Refused`, nothing runs after `shut`,
  nothing panics.
- "a flood of controls and a full inbox still let work progress every turn": every control
  requeues another control, a producer refills the inbox to 1,000 items before every turn, and
  100 work runnables wait; with the standard budget, every turn polls at least one work runnable,
  moves at most 32 inbox items, and `control_streak` never reads above 8. Removing the intake cap
  or the saturation makes it fail.
- A nested `pump` from inside a runnable returns `Stale`; a panicking task leaves the pump usable
  and its `Task` reports the panic; after `shut`, `wake` posts nothing.

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
  behaviour is unchanged. `succeed` and `fail` hand `dropped` to the sink at once (dropping starts
  nothing) and keep `released` in `StackState` **keyed by that top-level frame's id**
  (`HashMap<FrameId, Vec<u64>>`). A subscriber can commit transaction B while A is still
  publishing (A's context is popped before its publication, `native-writer/transaction.ts:195`),
  so there can be more than one pending list at once, and an unkeyed list would let B overwrite or
  consume A's.
- **Release comes after settlement and publication.** The shell's committed path
  (`publishSteps`, `native-writer/transaction.ts:257`) runs the outer outcome, every `Publish` and
  `Settle` step and the usage listeners, then, in a `finally` placed **before**
  `pass.rethrow()`, calls the new binding method `stack.releaseWakes(frame)` with its own top
  frame's id, which removes exactly that frame's list and hands it to the sink. So each list is
  released only after its own transaction's publication, a woken task always sees the committed
  rows and the published events, and a listener or settlement that throws never strands a wake.
  An unknown frame id is a no-op; a list still present when the engine closes is dropped and
  reported once through `onError` (a shell bug, never silent). A rollback has no pending
  release. With the engine off the list is always empty and the call does nothing. No borrow of
  `StackState` is held while the sink runs.
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
  ready queues are empty and no task is running, re-checked after each wait as
  `index.ts:1406`–`:1426` loops. Each module adds its own quiescence check through one
  `fn quiescent(&State, exclude: Option<TaskId>) -> bool` per module that E5.1 declares and calls
  (stubs return `true`: an unported module holds no work). **A flush excludes its own waiter**:
  called through a port from inside a task (`executor.current()` is `Some`), it waits for
  everything except that task and the worker run it belongs to, so a task that flushes never
  waits on itself. `flushDepth` (`:1407`) is kept as today. `flush()` has no deadline (callers
  and tests rely on it meaning quiescence); `close()` therefore never calls it (below).
- **Promise identity.** `ready()` returns the same promise object every time, created once in the
  constructor (`index.ts:1088`–`:1090`); `close()` caches its first promise (`closePromise ??=`,
  `:1429`) and returns that object on every later call. The facade holds both JS promises; Rust
  settles them and never creates a second.
- **Failed readiness.** If preparation or recovery fails, the ready promise rejects with that
  error, as today, and commands keep getting `engine_starting`. `close()` awaits the ready promise
  as `:1436` does, so its result is that error, but every shutdown step below still runs, so a
  failed start never leaks the threadsafe function or a timer.
- **`close()`** runs as one engine task, spawned once; its promise is the cached `closePromise`.
  The order is: the readiness wait and module steps, close admission, a bounded join, then
  cancellation. Nothing in it waits for a worker to go idle, and the **whole sequence runs under
  one overall deadline of 4.5 s** on the injected clock (`clock.setTimer`, so a `ManualClock` test
  advances it), so a port that never settles, wherever it is awaited, cannot stop close from
  finishing.
  - **The deadline** is armed as close's first action, before the readiness wait, and is the one
    timer step 2 does not cancel. Its value is derived from the daemon's shutdown budgets, which
    this task does not change (they are product behaviour, owned elsewhere), so the native close
    does what the TypeScript close does inside them:
    - **How the TypeScript close fits an 8 s stop plan into 6 s.** It does not cut session stops
      and has no deadline of its own: `Sessions.close(actor, "shutdown")` (`engine/sessions.ts:1053`)
      runs each session's polite stop inside `Engine.close` (`index.ts:1452`–`:1458`). The daemon
      bounds it from outside: when shutdown begins it arms `forceStopAfterPoliteWindow`
      (`apps/daemon/src/index.ts:502`–`:512`), which after `POLITE_SHUTDOWN_MS` = 3 s
      (`shutdown-processes.ts:8`) stops every owned process group and tree member
      (`stopOwnedGroups`, `stopMembers`) with `FORCED_GRACE_MS` = 0.5 s from SIGTERM to SIGKILL
      (`:10`). Those exits release the session closes, so the provider part of engine close ends
      about 3.5 s after shutdown begins. The engine's disposer (`services/engine.ts:506`) is
      bounded by the service cleanup budget of 6 s (`services/startup.ts:91`, shared budget
      `:586`–`:590`); past it the cleanup is logged as left running (`:337`–`:343`) and the
      process exits. The daemon as a whole has 7 s (`index.ts:515`–`:520`); the desktop's 10 s
      SIGTERM grace (`apps/desktop/src/main/daemon/supervisor-config.ts:127`) and the 30 s quit
      gate (`apps/desktop/src/main/os/quit-gate.ts:6`) sit
      outside both.
    - **The native close does the same.** It runs the same session closes with the same stop plan
      and never shortens them; the daemon's forced stop at 3 s + 0.5 s ends their processes
      through the same `@ace/provider-kit/process` exports, native behind `ACE_SUPERVISOR` or not,
      and those exits release them exactly as today.
    - **The value: 4.5 s**, from close's start. That is the forced stop's end (3.5 s) plus 1 s for
      the exits to be reaped and the final batches to commit and be acknowledged, and it leaves
      1.5 s of the 6 s cleanup budget for what runs after `engine.close` in that budget: the rest
      of the engine service's disposers (`registry.close()`, `services/engine.ts:75`, closes the
      adapters and their hosts) and the store's close, which closes after its dependents. So in
      the normal case the deadline never fires, because the forced stop has already released
      every session.
    - **When close starts late.** The 6 s budget is shared and starts at the first service's
      close; services that depend on the engine close before it, and the time they take is not
      the engine's. If they take more than 1.5 s, the shared budget can pass before the engine's
      4.5 s: the daemon then leaves the engine's cleanup running and exits, exactly as it does
      with the TypeScript engine today, and what was cut is lost as in a forced exit (below). The
      native deadline is never longer than the budget it sits in, and is not stretched to
      compensate.
  - **Everything awaitable counts against it**: the readiness wait (`:1436`), the module steps of
    step 1 and the join of step 3. The close task races that part (`futures::select` over the
    sequence and the deadline). When the deadline passes first, the sequence future is dropped
    where it stands, which cancels the readiness wait or the module step it was in, and close goes
    straight to step 2 if admission is still open, skips the join, and runs steps 4 to 6.
    Admission closing and steps 4 to 6 never await, so they finish within the turn the deadline
    fired in, and close settles inside the deadline plus that one turn.
  - A phase the deadline cut is reported once through `onError` as
    `Engine close passed its 4.5 s deadline during <phase>` (`readiness`, `<module> close`,
    `join`). Work it cut is handled as step 5 says. A session whose close was cut is dropped,
    which ends its process through the supervisor (kill-on-drop, ADR 0223 §2's `process-wrap`) if
    the daemon's forced stop has not already, and restart evidence it had not captured is treated by the next boot as a crash's (E5.8).
  1. **Module steps.** `Closing` (new facade calls get `Closing`, commands
     `daemon_shutting_down`); cancel the sweep; the module close steps in
     `index.ts:1428`–`:1466`'s order, each a declared function (E5.2, E5.6, E5.8 fill them): flush
     and capture restart evidence, then close sessions, whose frames still arrive (ADR 0223 §7
     rule 5) and whose stop plan bounds them (3 s/3 s/2 s). Before them, close awaits the ready
     promise as `:1436` does. All of this is under the overall deadline. The TypeScript's final
     `flush()` (`:1465`) is **not** run here; step 3 replaces it.
  2. **Close admission.** Cancel every timer the engine armed except close's deadline, unsubscribe from the registry
     (step 7), and call `executor.close_admission()`. From here no external producer can enqueue:
     a session event, I/O completion, timer firing or after-commit release that races it gets
     `Refused` and is dropped (it arrived after shutdown began, as an item arriving after
     `Engine.close` is ignored today).
  3. **The bounded join.** Close joins exactly two kinds of work, both already admitted:
     - **commits in flight**: runnables already queued whose step will commit (a frame batch, a
       receipt's follow-up, a recovery capture), and the after-commit wakes those commits release
       (released into the run queues directly, since the inbox is closed);
     - **acknowledgements already admitted**: every frame batch accepted into an actor's mailbox
       before admission closed is committed and its acknowledgement resolved (or, on a failed
       commit, rejected as today).

     The join is the ordinary pump on ordinary macrotasks (the threadsafe call and `setImmediate`
     re-arms), with the same budget and fairness, never called from inside the close task, so it
     is never re-entrant. It ends at the end of the first turn that finds the inbox and both run
     queues empty and no admitted batch unacknowledged. Tasks parked on a port, a timer or a
     promise are not runnable and do not hold it. It has no deadline of its own: it ends when the
     overall deadline passes, and whatever it had not finished is cancelled in step 4 with the
     rest.

  4. **Cancel the rest.** Detach the after-commit sink, then `executor.shut()`: `closed` is set,
     the run queues close, queued runnables are dropped, and every task still alive is cancelled.
     That covers workers awaiting a port (`prepareInput`, `beforeSend`, `prepareWorkspace`,
     `waitForProvider`, transition I/O), tasks waiting on timers, and facade calls awaiting a JS
     promise. A JS promise a cancelled task was waiting on cannot be cancelled; when it settles
     later, the binding's `then` callback finds its task gone and does nothing.
  5. **Reject, never drop silently.** Every facade promise still pending, except the close
     promise, rejects with `EngineClosed` (`Error("Engine closed")`, `code: "ACE_ENGINE_CLOSED"`).
     Every cancelled worker run is reported once through `onError` as
     `Engine closed while <worker> for <thread> waited on <port>`. The durable state it was moving
     (an intent mid-delivery, a queued input) stays as committed, held or uncertain, and the next
     boot's restart recovery (E5.8, behaviour.md §13) decides it, as after a crash today.
  6. **Settle the close promise** from its own result alone: the readiness error (`:1436` awaits
     the ready promise), else a module step's error, else success. A sequence the deadline cut is
     not an error of close: it resolves, and the deadline report and step 5's reports say what was
     cut. A ready promise still pending when the deadline cut the readiness wait is one of step 5's
     pending promises and rejects with `ACE_ENGINE_CLOSED`. Then zero the
     process-reference count and release the threadsafe function (step 6). The close task
     returns; its pump turn returns `Done` and nothing re-arms.

  A `close()` called from inside a task (through a port) gets the same cached promise; the close
  task's waits exclude the calling task, which is cancelled in step 4.

- **Tests** (seam):
  - "close finishes inside its deadline when a port stalls before admission closes", in two cases:
    `providersActivated` is a JS promise that never settles, so the readiness wait stalls; and a
    probe close step (`probe.stallCloseStep(port)`, declared in E5.1, which adds a module close
    step awaiting a never-settling port) stalls the module steps. In each, `close()`, then advance
    the `ManualClock`: close is still pending at 4.4 s and settles at 4.5 s within the turn the
    deadline fired in; admission was closed and the threadsafe function released; `onError` got
    one deadline report naming the phase (`readiness`, or the probe step); in the first case
    `ready()` rejects with `ACE_ENGINE_CLOSED`. A close whose readiness wait or module steps sit
    outside the deadline hangs this test.
  - "close finishes within its deadline when a worker waits on a port that never settles": the
    probe runs a worker task awaiting a port whose JS promise never settles, plus a facade call
    tied to it; `close()`, then advance the `ManualClock` 4.5 s; close resolves, the facade call
    rejects with `ACE_ENGINE_CLOSED`, `onError` got one report naming the worker and the port, and
    resolving that JS promise afterwards changes nothing. A close that awaits worker idleness
    hangs this test.
  - "close joins a commit and an acknowledgement admitted before admission closed": the probe
    queues a step that commits and an admitted batch, then `close()`; after it the row is in the
    store and the acknowledgement resolved, with the clock never advanced.
  - "a shutdown join longer than one budget completes over several macrotasks": 200 chained
    runnables queued, then close; `turns()` shows more than one turn after admission closed,
    every runnable ran, no pump entry returned `Stale` from inside the close task.
  - "close settles its own promise even when it cancels pending work" (a second `close()` returns
    the same object), and "a failed ready still shuts down" (close rejects with the readiness
    error, the threadsafe function is released).
  - The racing-producer test is in step 2.

- **A forced exit** (`process.exit`, a signal, a crash) runs none of this. What is lost is what was
  never committed: frames read but not in a committed batch, live deltas the store had not
  flushed, wakes deferred by a transaction that never committed, and tasks mid-step. Everything
  committed survives (receipts, intents, queue rows, folded state), and the next boot's restart
  recovery (behaviour.md §13, E5.8) treats the lost part exactly as it treats a crash of the
  TypeScript engine today: interrupted turns are recovered or ended, unacknowledged frames are
  gone.

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
`advance()` (owner decision 2). The seam proves the observable order: two timers armed with a
`ManualClock` and one `advance()` that fires both resume their tasks in firing order in the next
pump; state read synchronously right after `advance()` is unchanged, and after `await flush()` it
shows both.

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

- **Keeping the process alive.** The binding counts holders: pending facade promises and open
  native session queues. At 0 → 1 it `ref`s the threadsafe function, at 1 → 0 it `unref`s it, both
  on the JS thread. So an engine with outstanding work keeps the process up exactly as long as
  that work exists, and an idle engine never does, like today's `unref`'d timers (`actor.ts:39`).
  The terminal cleanup (step 4) zeroes the count before release.
- **Release.** `close()` releases the function last (step 4). After release, `wake()` returns at
  `closed`, so it neither posts nor meets `Closing`.
- **Proof**: `native-engine/liveness.process.test.ts`, one file, three cases, each a child Bun
  process with the switch on (a real process exit is the edge; no unit test can see it): "a
  closed native engine lets its process exit", "a pending engine promise keeps its process alive
  until it settles, then lets it exit", "an idle native engine never keeps its process alive" (the
  child builds an engine, never closes it, and must exit on its own). Each child must exit within
  5 s; the file is within the 30 s process budget.

### 7. The registry (`ace-engine/src/registry.rs`, shell over `engine/registry.ts`)

`AdapterRegistry` stays the TypeScript class tests construct and pass as `options.registry`, and
its JS API stays **backend-neutral**: the same object outlives engines. A restart reuses it across
boots (`recovery-test-support.ts:61`–`:66`, `:68`–`:79`), and under `ACE_NATIVE_CROSS=ACE_ENGINE`
consecutive boots alternate backends, so one registry must serve a TypeScript engine, then a
native one, then a TypeScript one. So the class never changes backend, and each native `Engine`
binds its own **native view** of it:

- `registry.ts` gains one method, `observe(listener): () => void`, called after every `register`,
  `refreshDiscovery` and `bindSessions` with the changed entries (provider, backend, adapter
  object, capabilities, discovery). With no listener it does nothing, so the off path is
  unchanged. Registration rules (Cursor refuses ACP and defaults to `cursor-sdk`, `:13`–`:16`; the
  refresh's path-and-version match, `:30`–`:40`), `bindSessions` and `close` stay in TypeScript,
  the one owner of the JS adapter objects.
- `ace-engine/src/registry.rs` is the view: entries by provider and by `provider:backend`, each
  with an adapter handle `A` (a napi reference to the current bound adapter), capabilities and
  discovery as `ace_json::Value`, and the lookup rules the engine needs: `get` pins Cursor to
  `cursor-sdk` and fails with the same "provider isn't ready" message (`:41`–`:52`); `has` with an
  identity asks the adapter (`:85`–`:88`). The native engine copies the entries at construction,
  subscribes with `observe`, and unsubscribes in its terminal cleanup. It never calls
  `registry.close()`; the registry's owner does, as today.
- `registry.test.ts` stays as it is and passes on and off (the class is unchanged). Its cases
  guard TypeScript code that stays, so none move; the view's lookup rules get their (b) cases
  when E5.6 opens sessions through it.
- `adapters.ts` stays TypeScript (owner decision 4), and its three (b) cases with it.

### 8. The store seam (`ace-engine/src/lib.rs` `EngineStore`, shell `native-writer/transaction.ts`)

The engine writes through the shared stack (ADR 0223 §5, `:300`), and every transaction,
whoever opens it, lives in **one shell context** (`NativeTransactions.contexts`,
`native-writer/transaction.ts:88`) from before its body to after its last step. Without that, a
Rust-opened transaction would run its body with no JS context: a re-entrant `Store.atomic` from a
port would see no context (`:123`), start a "top-level" JS frame while Rust's frame is open on the
stack, and the shell could lose event positions or settlement callbacks.

- **The shell splits `transaction` into halves** (`:118`–`:162`), with no change in what runs or
  in what order:

  ```ts
  /** Flush, history check, context push (if top), register the outcome, stack.begin, evidence, beginThreads. */
  open(outcome?: TransactionOutcome): OpenFrame;
  /** finishCall, then finishNested or finishTop (one ordered pass over Finish.steps), doom bookkeeping, throw. */
  close(frame: OpenFrame, result: { threw: false } | { threw: true; error: unknown }): void;
  transaction<T>(run: () => T, outcome?: TransactionOutcome): T; // open; run; close, as today
  ```

- **Rust opens through the shell.** `EngineStore::atomic(run)` calls the shell port `open()`, so
  the context exists and the shell begins the stack frame, top-level or nested exactly as a JS
  caller would get it; then runs `run` synchronously; then calls the shell port `close(frame,
result)`. A port the body calls that runs `Store.atomic` nests as a savepoint in the same
  context; a Rust `atomic` inside a JS-opened transaction gets a nested frame in the JS context.
  One stack and one context list, so positions cannot diverge.
- **Events enter once per batch.** Each batch of events the engine writes is passed to the shell's
  `append` (`:104`–`:109`) exactly once, through the shell port `appendEvents(json)`, right after
  the write; the shell's event list and `noteEvents` remain the only positions.
- **One ordered pass.** `close` applies `Finish` as the shell does today: for a nested frame,
  rollback truncation to `eventsLen` and the savepoint's `Settle` steps (`finishNested`); for the
  top, the thread-cache lifecycle (`commitThreads`/`endThreads`, or `topRolledBack`), the context
  pop before publication (`:195`), then `publishSteps` in `Finish.steps` order with outer-outcome
  suppression (`commit_steps`, `ace-store/src/writer/transaction.rs:364`–`:368`), the usage
  listeners, the wake release (step 3), and `pass.rethrow()`. Nothing is applied twice, and
  nothing outside this pass.
- **No transaction is held across `Pending`.** `run` is a synchronous `FnOnce(&Tx) -> R`; `Tx`
  borrows the connection for the call and is neither `'static` nor storable, so no future can
  hold it across an await. A task that needs a transaction opens and closes it inside one poll.
- A Rust transaction never resolves a frame's acknowledgement on a savepoint's release
  (ADR 0223 §4); `EngineStore` exposes `is_outermost()` and E5.2 asserts it.
- **Tests** (through the seam, step 12; new behaviour, since only Rust opens transactions this
  way): "a transaction a subscriber commits during another's publication releases its own wakes
  after its own publication, and the outer's are released after the outer's, each exactly once"
  (the probe's wake log records how many publications had finished at each release; making
  `releaseWakes` unkeyed makes it fail); "a JavaScript transaction inside a Rust one publishes both batches once, in position, and
  settles its outcome once"; "a Rust write inside a JavaScript transaction rolls back with it, and
  its deferred wake never runs"; "a subscriber that writes during publication opens a fresh
  top-level transaction, and both wakes run after their own publications"; "a throwing subscriber
  still releases the transaction's wakes". The probe writes the events, so these run before any
  module is ported.

### 9. The facade (`apps/daemon/src/native-engine/`, binding `ace-daemon-node/src/engine/`)

`native-engine/engine.ts` holds `class NativeEngine` with every public member of `Engine`
(`engine/index.ts:80`–`:1467`), each a one-line delegation to a function in
`native-engine/<module>.ts` (the E0 stubs; E5.1 fills them all now) that encodes arguments,
calls the binding, decodes the result and maps errors. `engine.ts` stays under 400 lines that way.
The binding struct `#[napi] pub struct NativeEngine` is in `engine/mod.rs`; each item adds its
methods in its own `#[napi] impl NativeEngine` block in `engine/<module>.rs`. The shell's
interface to the addon marks each method optional. A missing one fails with
`NativeEngineIncomplete("<method> lands in E5.<n>")` in the member's own timing: a sync member
throws it; an **async member returns a rejected promise and never throws synchronously** (callers
chain `.catch` or `await`, and a synchronous throw would escape them). So the facade is complete
from E5.1 on and an item lands by adding its binding block.

Kinds (behaviour.md §1): **R** synchronous read, a sync napi call returning finished JSON;
**M** synchronous mutation, committing before it returns (inside the caller's transaction if one
is open); **A** async, a promise the Rust task resolves from the pump; **H** the handler,
synchronous inside the receipt transaction; **B** binder, stores a JS callback as a port, sync.
Errors cross as the engine-api classes (`InputRejected`, `SteerTargetLost`, `AccessError`,
`SessionOpenError`) by a fixed `code` (ADR 0223 §7 rule 2).

| Member (`index.ts` line)                                                                                                                                                              | Kind                           | Rust filled by                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------- |
| `constructor` (`:159`)                                                                                                                                                                | M                              | E5.1                                     |
| `handler`, `internalHandler` (`:83`, `:85`, built `:454`–`:476`)                                                                                                                      | H                              | E5.4                                     |
| `guests` (`:92`), `hosts` (`:94`): facade objects over `guest-threads.ts`, `host-threads.ts`                                                                                          | R/M                            | E5.7                                     |
| `retrySettled` (`:491`)                                                                                                                                                               | A                              | E5.10                                    |
| `bindOwnershipFence` (`:500`)                                                                                                                                                         | B                              | E5.1 (stored); E5.9 uses it              |
| `ownershipRefusal` (`:504`); `liveMove` object (`:507`)                                                                                                                               | R; R/M                         | E5.9                                     |
| `bindCommandPolicy` (`:519`), `bindHostInteractions` (`:819`), `bindExternalTaskStop` (`:834`), `bindDeletionPolicy` (`:1028`)                                                        | B                              | E5.1 (stored); used by E5.4, E5.7, E5.10 |
| `ensureProvider` (`:565`)                                                                                                                                                             | A                              | E5.1                                     |
| `providerAvailability` (`:568`), `capabilities` (`:573`, a fresh copy each call)                                                                                                      | R                              | E5.1                                     |
| `supportsSteering` (`:577`), `messageFacts` (`:581`)                                                                                                                                  | R                              | E5.5                                     |
| `prioritizeSubagentResult` (`:591`)                                                                                                                                                   | M                              | E5.4                                     |
| `spawn` (`:599`), `admitCreation` (`:1095`), `creationPending` (`:1092`)                                                                                                              | M; M; R                        | E5.4                                     |
| `access` (`:647`), `targetInstance` (`:664`), `childAccess` (`:676`), `offeredModes` (`:690`), `childPermissionRefusal` (`:704`)                                                      | R                              | E5.7                                     |
| `attachChild` (`:717`), `updateChild` (`:720`), `machineChild` (`:725`), `transferHold` (`:732`), `externalHold` (`:745`), `delegationStarted` (`:785`), `delegationSettled` (`:788`) | M                              | E5.10                                    |
| `machineHandoff` (`:774`); `adoptMachineHandoff` (`:782`)                                                                                                                             | R; M                           | E5.9                                     |
| `workload` (`:792`), `providerProcesses` (`:805`)                                                                                                                                     | R                              | E5.2 (backlog), E5.6 (processes)         |
| `backgroundPorts` (`:826`): an object over three sync calls                                                                                                                           | R/M                            | E5.6                                     |
| `rootAgent` (`:853`, may apply a tick), `activeRun` (`:862`), `turnOrigin`, `delegationsInFlight` (`:866`–`:867`), `aceCaller` (`:869`), `withinAgent` (`:874`)                       | R (rootAgent M)                | E5.2, E5.5                               |
| `openHostApproval` (`:878`), `hostError` (`:889`), `hostNotice` (`:893`), `resolveHostApproval` (`:896`), `closeHostGate` (`:910`)                                                    | M                              | E5.7                                     |
| `discardRecovery` (`:914`), `cancelRecovery` (`:918`), `captureContinuation` (`:927`)                                                                                                 | M                              | E5.8                                     |
| `cancelDelegatedInputs` (`:921`)                                                                                                                                                      | M (its wakes deferred, step 3) | E5.4                                     |
| `changeWorkspace` (`:930`)                                                                                                                                                            | A                              | E5.9                                     |
| `reconcileThread` (`:965`), `reconcileOwn` (`:970`)                                                                                                                                   | A                              | E5.10                                    |
| `hasSession` (`:975`), `hasState` (`:983`)                                                                                                                                            | R                              | E5.6; E5.3                               |
| `cleanupThreads` (`:986`), `liveWork` (`:989`), `runsProviderWork` (`:993`), `hasUnfinishedWork` (`:1016`)                                                                            | R                              | E5.10                                    |
| `stopForDeletion` (`:997`), `cleanupSession` (`:1020`), `stopForCancellation` (`:1024`)                                                                                               | A                              | E5.10                                    |
| `forgetPurged` (`:1004`), `prepareDeletion` (`:1031`)                                                                                                                                 | M                              | E5.10                                    |
| `setSilenceMs` (`:1034`), `clearWorkspaceSilenceMs` (`:1046`)                                                                                                                         | M                              | E5.6                                     |
| `liveThreadIds` (`:1049`)                                                                                                                                                             | R                              | E5.2                                     |
| `continueImported` (`:1052`)                                                                                                                                                          | A                              | E5.8                                     |
| `sessionMetadata` (`:1072`)                                                                                                                                                           | R                              | E5.6                                     |
| `commandFailure` (`:1076`), `commandExecution` (`:1079`), `queuePage` (`:1082`), `queue` (`:1146`), `inputFate` (`:1135`)                                                             | R                              | E5.4                                     |
| `retainsAttachment` (`:1085`), `readRawBlob` (`:1402`, bytes, not JSON)                                                                                                               | R                              | E5.3                                     |
| `ready` (`:1088`), `flush` (`:1406`), `close` (`:1428`)                                                                                                                               | A                              | E5.1                                     |
| `prepareCommand` (`:1111`)                                                                                                                                                            | A                              | E5.4                                     |
| `admissionReopened` (`:1150`), `accountRecovered` (`:1213`)                                                                                                                           | M                              | E5.4; E5.8                               |
| `resuming` (`:1155`), `endedOnLimit` (`:1162`), `treeActive` (`:1176`), `limitContinues` (`:1183`), `heldInterrupted` (`:1196`), `limitsMatter` (`:1204`)                             | R                              | E5.8                                     |
| `onLimitPolicy` (`:1193`)                                                                                                                                                             | B (returns an unsubscribe)     | E5.1 (stored); E5.8 fires it             |

The builder checks this list against `index.ts` before writing: any public member it finds that is
not here joins the table with its kind, in the same commit. The handler keeps today's shape in the
shell: `store.atomic(() => fenceCommand ?? hostInteraction?.(command) ?? policy(command, accept))`
where every engine step is a sync binding call, so the JS policies run in JS inside the same
transaction and the binding never calls a policy from inside its own borrow. Around it the shell
keeps today's call sites exactly: `handler.handle` normalizes with `personCommand(command)` and
calls `internalHandler.handle` (`:478`–`:481`); `internalHandler.handle` refuses while closing or
starting (`:457`–`:460`), and calls `commanded` (`:474`) **only when `result.ok`**, after the
receipt's transaction has returned, as a binding call. Neither the normalization nor the success
guard moves into Rust.

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

### 12. The test seam (`apps/daemon/src/native-engine/testing.ts`, binding feature `engine-probe`)

A test-only way to build the **whole native engine** on a real `Store`, with seeded fixtures and
scripted ports, so each E5 item shows its behaviour natively as it lands, before its class (a)
files can pass end to end (owner decision 1).

```ts
export interface EngineSeam {
  store: Store; // a real Store on a temp home: ACE_STORE=native with the transactions writer
  engine: Engine; // the native facade, built exactly as `new Engine` builds it
  clock: ManualClock;
  ports: PortLog; // every port call, in order, with its arguments
  probe: EngineProbe; // test-only binding methods, below
  close(): Promise<void>; // engine, then store, then the temp home
}
export function engineSeam(input?: {
  seed?: (store: Store) => void | Promise<void>; // fixtures, written before the engine opens
  seedWithTypeScript?: { script: string; args?: readonly string[] }; // a child with the switch off
  options?: Partial<EngineOptions>; // scripted ports: @ace/adapter-testkit adapters, onError, …
}): Promise<EngineSeam>;
```

- **Fixtures** are rows the TypeScript engine writes, seeded through the store's APIs and the
  existing builders (`engine/test-support.ts`, `recovery-test-support.ts`), never hand-written
  JSON.
- **A home the TypeScript engine wrote** is seeded in a **child process** with the switch off:
  `engineSeam({ seedWithTypeScript: { script, args } })` runs `bun <script>` on the temp home with
  `ACE_ENGINE` and `ACE_NATIVE_CROSS` removed from its environment, waits for it to exit 0, then
  opens the native engine. It cannot run in the test's own process: the backend is read when
  `native-switches.ts` is imported (`:93`), so every `Engine` in that process is native. Tests that
  seed this way are process tests, in one `native-engine/<item>-home.process.test.ts` per item
  that needs it (the real edge is the second process).
- **The probe** (`EngineProbe`, compiled only with the cargo feature `engine-probe`, which release
  packaging never sets) exposes executor and store hooks with no thread behaviour:
  `spawn(lane, script)` runs a scripted task (await a timer, call a port, write events in a
  transaction, defer a wake, flush from inside); `defer(threadId)`; `claim()`; `turns()` (polls per
  turn, longest poll); `woken()` (wakes released, in order); `stallCloseStep(port)` (a close step that awaits a
  port, for the deadline test); and, until E5.3 lands,
  `emptyCandidates()`, which answers the recovery-candidate scan with no rows so `ready()` can
  resolve. That is the probe's one stub, and E5.3 deletes it. E5.1 also **declares** the hook
  E5.2 needs, so E5.2 does not edit `testing.ts`:
  `attachSession(threadId, spec: ScriptedSessionSpec): Promise<ProbeSession>`, which attaches a
  scripted `@ace/adapter-testkit` session to a thread's actor without E5.6's session opening
  (`ProbeSession` offers `frame(...)`, `exit(code)` and `commands()`). Until E5.2 adds its binding
  in `engine/probe_actor.rs`, it returns a promise rejected with
  `NativeEngineIncomplete("attachSession lands in E5.2")`. Without the feature, `engineSeam`
  throws `the engine probe is not built: cargo build --release -p ace-daemon-node --features
engine-probe`; it never skips.
- Seam tests live in `native-engine/skeleton.test.ts` (E5.1's) and one `native-engine/<item>.test.ts`
  per later item, wrapped in `describe.runIf(engineBackend() === "native")` (the pattern of
  `native-loopback.process.test.ts:301`), so the default tiers are unchanged and the switch-on
  proof runs them, with the evidence file showing they did. Each seam test covers behaviour no (a)
  file can yet show natively, names in a comment the (a) test that will show it, and is deleted in
  the commit where that (a) file first passes with the switch on. Tests move, they don't
  multiply: the seam is scaffolding, not a second suite.

**What each item unblocks.** "Seam" is that item's seam file; the (a) files are the guide's rows,
each run alone with the switch on. Each item checks its row against the files and amends this
table in its PR.

| Item  | Native proof it unblocks                                                                                                                                                                                                                                        | Still blocked, and by                                                                                                                                           |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E5.1  | Seam: the claim (lost wake, budget boundary), pump and fairness on real Bun macrotasks; after-commit release and drop; both nesting directions, subscriber re-entry, a throwing subscriber (step 8); timer order (step 5); promise identity; `liveness.process` | The smoke on a home without the probe (`ready()` needs `repository::recovery_candidates`, E5.3); every (a) file                                                 |
| E5.2  | Seam: a scripted session attached to an actor by the probe; batch acknowledgement on the outermost commit, live-buffer acceptance, outputFlow pause at 256 and resume at 64                                                                                     | `signal-batching`, `sdk-burst`, `streaming-behaviour` open real sessions (E5.6)                                                                                 |
| E5.3  | The smoke: construct, `ready()`, `flush()`, `close()` on fresh and seeded homes, one evidence line, the probe's stub deleted; storage-row files that open no session; a TypeScript-written home read natively                                                   | `startup-quarantine` (E5.8); storage files that open sessions (E5.6)                                                                                            |
| E5.4  | Commands-row files that never open a session; `queue`, `queuePage`, `inputFate`, `commandFailure` after real receipts                                                                                                                                           | Every file that sends (E5.5, E5.6)                                                                                                                              |
| E5.5  | Seam: delivery and steering against a probe-attached session                                                                                                                                                                                                    | End-to-end sends (E5.6)                                                                                                                                         |
| E5.6  | `engine.process` `:23`, `:186`, `:207`, `:282`, `:302`; `main-integration.process` `:33`, `:63`, `:143`, `:169`, `:211`, `:241`; E5.2's three files; the sessions row                                                                                           | `engine.process` `:97` (verify: snapshot rollback, E5.3 or E5.6), `:139` (E5.7), `:227` (E5.8), `:248` (E5.10); `main-integration.process` `:85`, `:275` (E5.8) |
| E5.7  | `engine.process` `:139`; the access row                                                                                                                                                                                                                         | as above                                                                                                                                                        |
| E5.8  | `engine.process` `:227`; `main-integration.process` all green (`:85`, `:275`); the restart row; the first E5 cross-mode run; `head-of-line.ts` with the switch on                                                                                               | `engine.process` `:248` (E5.10)                                                                                                                                 |
| E5.9  | The transitions row                                                                                                                                                                                                                                             | none of its own                                                                                                                                                 |
| E5.10 | `engine.process` all green (`:248` stops a background task with `background_task.stop`, `:276`, which the controls worker runs); the stop row; the 56 files outside `engine/`                                                                                   | none                                                                                                                                                            |

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
8. No transaction is held across `Pending` (step 8): a transaction opens and closes inside one
   poll.
9. **No port may await an engine barrier that depends on the task calling it.** A port called from
   task T must not await anything that waits for T. The barriers enforce it rather than trusting
   ports: `flush` and `close` exclude their caller (step 4), and `drain(id)` called from the worker
   task of `id` resolves at once. A cycle through two tasks (T awaits U's barrier while U awaits
   T's) is a design bug the reviewer looks for; the TypeScript has none (`workers.ts` has no
   cross-thread drain).

## Proof

Correction to the guide's E5 table: `engine.process` and `main-integration.process` cannot be the
first green "with E5.2 to E5.4". Their tests open sessions, deliver, resolve interactions, restart
and stop background tasks. `main-integration.process` is first all green at **E5.8** (`:85`
restarts); `engine.process` at **E5.10**, because `:248`–`:280` stops a background task
(`background_task.stop`, `:276`), a control the controls worker runs. Until then each fails with
`NativeEngineIncomplete` naming the item, which is the expected result. Step 12's table is the
order in between.

What E5.1 alone proves, natively:

- **Through the seam** (`native-engine/skeleton.test.ts`, switch on, addon built with
  `engine-probe`): the executor, the pump and the wake semantics on real Bun macrotasks and a real
  Store. That covers the lost-wake interleaving and the budget-boundary case end to end (one
  notification, every item run), control fairness, a nested pump, timer order, the after-commit
  release after publication and the drop on rollback, both nesting directions, subscriber
  re-entry and a throwing subscriber, a flush from inside a task that does not wait on itself, a
  missing async binding rejecting without a synchronous throw, `ready()` and `close()` returning
  the same promise object on every call, a failed `ready()` still releasing everything in
  `close()`, and the terminal cleanup rejecting a pending promise with "Engine closed".
- **`native-engine/liveness.process.test.ts`**: the three process-exit cases (step 6).
- **Rust**: `cargo test -p ace-engine` (claim, pump, fairness, workers, limits) and
  `cargo test -p ace-store` (the after-commit exactly-once table).
- **Switch off, byte-identical**: each file alone, unchanged and passing:
  `engine/engine.process.test.ts`, `engine/main-integration.process.test.ts`,
  `engine/registry.test.ts`, `engine/adapters.test.ts`, `engine/restart-resume.process.test.ts`
  (it reuses a registry across engines), `packages/provider-kit/src/native-switches.test.ts`, and
  the store's Task 5.5 proof list with
  `ACE_STORE=native ACE_STORE_WRITER=fold,sequences,events,columns,live,transactions` (the shell's
  split into halves, the shared stack and the wake release must change nothing there).
- **Not yet**: the construct/ready/flush/close smoke without the probe needs E5.3, and no (a) file
  passes with the switch on.

```sh
(cd native/daemon && PATH=$HOME/.rustup/toolchains/1.95.0-aarch64-apple-darwin/bin:$PATH \
  CARGO_BUILD_JOBS=4 cargo build --release -p ace-daemon-node --features engine-probe)
for f in apps/daemon/src/native-engine/skeleton.test.ts apps/daemon/src/native-engine/liveness.process.test.ts; do
  e=$(mktemp)
  test -f "$f" && ACE_STORE=native ACE_STORE_WRITER=fold,sequences,events,columns,live,transactions \
    ACE_ENGINE=native ACE_ENGINE_EVIDENCE="$e" bun --bun x vitest run "$f" --maxWorkers=4 && test -s "$e"
done
f=apps/daemon/src/engine/registry.test.ts
test -f "$f" && bun --bun x vitest run "$f" --maxWorkers=4
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
  From E5.8, the switch-on head-of-line run also reports the longest single poll and the count of
  polls over 16 ms (the binding's counters), beside `stopAck`. No new bench file.
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
- `apps/daemon/src/native-engine/{engine,ports,testing}.ts`, `skeleton.test.ts`,
  `liveness.process.test.ts`, and the facade functions in `native-engine/<module>.ts`; the one
  `if` in `engine/index.ts`; `observe` in `engine/registry.ts`; the `open`/`close` split,
  `appendEvents` and the `releaseWakes` call in `native-writer/transaction.ts`;
  `engineSwitchRefusal` and its table in `native-switches.ts` and its test;
  `scripts/test-home-policy.ts`.
- `ace-daemon-node`'s `engine-probe` feature and its probe module (`engine/probe.rs`), compiled
  out of release builds.
- **The addon wiring.** `native/daemon/crates/ace-daemon-node/Cargo.toml`: add
  `ace-engine = { path = "../ace-engine" }` to `[dependencies]` (beside `ace-store`, `:18`, with a
  comment saying why) and `[features] engine-probe = []`. `src/lib.rs`: `mod engine;` (`:13`)
  already declares the module, but nothing builds an engine; add the factory on the database
  handle, `#[napi] fn native_engine(&self, options: …) -> engine::NativeEngine`, which gives the
  engine the handle's connection and its shared stack, as `transaction_stack()` does
  (`writer.rs:137`), and `#[cfg(feature = "engine-probe")] mod probe;` inside `engine/mod.rs`.
  `engine/probe_actor.rs` is declared there now (empty, E5.2's).
- Every file under 400 lines; none over 1,500 (`bun run check:size`). Split `executor.rs` into
  `executor/{claim,pump,after_commit}.rs` if it grows past 400.
- `ace-engine/Cargo.toml`: drop `serde_json` (rule 8: JSON goes through `ace-json`) and add
  `ace-json`; nothing else new.

## Must not

- Port any thread behaviour, or make an unported path succeed silently.
- Call a TypeScript engine module from Rust, or keep a TypeScript `Engine` alive beside a native
  one.
- Run a runnable outside `pump`, or start a task from a sync entry except through `defer`.
- Hold a transaction or a `with_state` borrow across an await.
- Give the probe any thread behaviour, or ship the `engine-probe` feature.
- Run the shutdown join from inside the close task, let an external producer enqueue after
  `close_admission`, or make close wait for a worker to go idle.
- Change the store's stored formats, `engineSchemaVersion` 9, or `finish_json`'s output.
- Run the full suite, `bun run check`, `test:process` or any tier; one file at a time (rule 3).

## Reviewer checks

- The claim table matches ADR 0223 §4 move for move; every move retries against the observed
  state; `notify` is called only after a successful `Idle → Scheduled`; `Closing` leaves
  `Scheduled`. Replacing the producer's loop with two fixed CAS attempts makes the lost-wake test
  fail.
- Controls run first but yield one work runnable after 8 in a row; the budget is 64 runnables or
  4 ms across both lanes; intake takes at most 32 inbox items and 2 ms per turn, and a turn with a
  non-empty run queue always polls at least one runnable.
- A Rust-opened transaction pushes its shell context before its body; the wake release runs after
  publication and before `pass.rethrow()`.
- A missing async binding returns a rejected promise; `ready()` and `close()` return identical
  promise objects on repeated calls.
- The registry class is unchanged in behaviour; each native view subscribes and unsubscribes.
- Wake lists are keyed by top frame and each is released after its own publication.
- `control_streak` lives in the executor, survives a turn's end and saturates at 8.
- Close arms one 4.5 s deadline first (derived in step 4 from `shutdown-processes.ts:8`, `:10`
  and the 6 s budget at `services/startup.ts:588`), and the readiness wait, the module steps, admission
  closing, the join and cancellation all fall under it; it joins only admitted commits and
  acknowledgements on scheduled macrotasks, then cancels and rejects the rest with
  `ACE_ENGINE_CLOSED`; the close promise settles from its own result, apart from cancelled work.
- `with_state`'s closure type admits no port, executor or store; no `&mut self` on `NativeEngine`.
- A token is released or dropped exactly once; a rolled-back receipt's wake never runs (make one
  table row fail by moving `dropped` to `released`).
- With the switch off, `git diff origin/ace/daemon-rust-rewrite -- apps/daemon/src/engine` shows
  only the one `if` and `observe`.

## Owner decisions (2026-11-24)

1. **Unported paths fail at the call, not at boot**, with `NativeEngineIncomplete` naming the
   item; the switch stays undocumented and default-off until E5.10. Every item also gets an
   observable native proof as it lands, through the whole-engine test seam of step 12 (a real
   Store, seeded fixtures, scripted ports), with the unblocked and still-blocked suites listed per
   item there. E5.1's own native proof is the executor, pump and wake semantics through that seam;
   the construct/ready/close smoke without the probe needs E5.3.
2. **Code awaiting a timer resumes in the next macrotask**, accepted as ADR 0223 §4 has it; the
   observable ordering is tested through the seam (step 5).
3. **Dynamic threadsafe-function refs**, accepted, with the terminal cleanup of step 4 and the
   child-process liveness file of step 6.
4. **`adapters.ts` stays TypeScript**, and its (b) cases with it; the guide's E5.1 row drops
   `adapters` from the cases to move.
5. **The wake list shares the store's transaction stack** (store Task 5.5's file, with a store
   reviewer on that commit), and wakes are released after the shell's settlement and publication,
   even when a listener throws (step 3).
6. **No post-hoc `finishForeign`.** Rust-opened transactions share the shell's context lifecycle
   from before their body (step 8). The cost, a few JSON crossings per step commit, is measured in
   E5.3 with `bench/sqlite-store.ts --split`.
