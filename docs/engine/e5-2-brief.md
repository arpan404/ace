# E5.2: the actor and frames in Rust (switch `ACE_ENGINE=native`, default off)

Part of the [engine porting guide](porting-guide.md). Its rules 1–16, "Files per work item" and
"For every E5 item" apply unchanged, and so does everything the [E5.1 brief](e5-1-brief.md) fixes:
the executor, the pump and its claim, the after-commit `defer`, the store seam, the re-entrancy
rules, the test seam and its rule that an unported path fails at the call with
`NativeEngineIncomplete: <what> lands in E5.<n>`. Where this brief is more exact, it wins. Read
[ADR 0223](../adr/0223-the-engine-and-adapters-move-to-rust-behind-the-same-interfaces.md) §4
(the acknowledgement bullet, `:233`–`:240`), §5 and §7 rules 3 to 5 first, then
[behaviour.md](behaviour.md) §4 (every numbered item is contract), then the E5.1 code on
`origin/ace/rust-engine-e5-1` (`ace-engine/src/lib.rs`, `executor.rs`, `ports.rs`, the binding's
`engine/mod.rs`, `ports.rs`, `probe.rs` and the shell's `native-engine/testing.ts`).

E5.2 ports the one path from a provider's output to the store: the per-thread mailbox that orders
frames, ticks and engine operations; frame intake, envelope checks and byte accounting; batching;
the acknowledgement; flow control; overflow and poisoning; the actor's deadline timer; and the
pure frame helpers the repository calls (coalescing, capping, the streamed-byte measure, attachment
echoes and correlations, the streaming fold). It ports no repository, queue, delivery or session
behaviour. Those reach the actor through two traits this brief fixes (step 6), whose methods fail
with `NotPorted` naming their owner until that owner lands. It also moves the engine's live
writes onto the connection's one live buffer, with that buffer's flush run by the pump (step 16).

Revised 2026-11-24 after review (gpt-6.2-sol). The mailbox task now polls its timer receivers,
so an idle actor cannot strand its last batch or tick (decision 3). A JavaScript acknowledgement
ends the pump turn, which keeps continuation order (decision 5). The live buffer is the shared
one and its flush is a pump task (step 16). The translator is taken out for each call, never
borrowed across one (step 7). Byte and echo parity is tightened (steps 3 and 4), and the native
path carries the bridge's payload limits and per-frame flow mirroring (steps 12 and 13). The
owner's decisions are recorded at the end.

## Branch

Branch from `origin/ace/daemon-rust-rewrite` once E5.1 has merged into it. Until then, branch from
`origin/ace/rust-engine-e5-1` and merge `origin/ace/daemon-rust-rewrite` into it when E5.1 lands.
Never rebase. Branch: `ace/rust-engine-e5-2`.

## Decisions this brief makes

1. **The actor's dependencies are two traits, not engine modules.** The actor calls the
   repository (E5.3), the queue (E5.4), delivery (E5.5), sessions (E5.6) and recovery (E5.8) at
   fixed points (`actor.ts:353`–`:443`). Built in parallel with E5.3 and E5.4, it cannot call
   functions those items have not written. So `actor/deps.rs` declares `ActorRepo` (what the
   actor reads and writes) and `ActorLinks` (what it causes elsewhere). Each method is mapped to
   its TypeScript line and owner (step 6). The production implementation returns `NotPorted` for
   each until its owner replaces that one method's body. The probe supplies a scripted
   implementation, which is how E5.2 proves itself before E5.3 (step 15).
2. **Frames keep their origin.** A frame from a TypeScript session stays a JavaScript object,
   held by the shell under a handle. Rust holds the handle, its byte count and its envelope
   verdict, and the JavaScript translator reads the object itself (step 13). A frame from a native
   session is an `ace_adapter_api::Frame` and never becomes a JavaScript object (ADR 0223 §7,
   "Native both"). The batching, acknowledgement and flow-control code is one code path for both.
3. **A batch's boundary is the firing instant, not the pump, and a firing always wakes the
   actor.** The TypeScript seals a batch synchronously inside the batch timer's callback
   (`actor.ts:340`) and enqueues a tick inside the actor timer's (`:565`). In Rust a timer
   firing only completes its `Timer::fired` oneshot (E5.1 step 5, binding `engine/ports.rs:258`),
   and that send wakes only a task that has **polled** the receiver. So both halves are needed:
   - **Synchronous catch-up.** Every synchronous entry into an actor (`frame`, `enqueue`, `flush`,
     `stop`, `quarantine`) first runs `catch_up`, which checks both receivers with `try_recv`: a
     fired actor timer enqueues its tick, which seals first, and a fired batch timer seals. A frame
     that arrives after a firing but before the next pump therefore lands in the next batch,
     exactly as in TypeScript. If both timers fired, the result is the same in either order:
     `enqueue` seals before it queues the tick.
   - **The mailbox task polls both receivers.** `try_recv` registers no waker. So every time the
     mailbox task is about to park, it polls both receivers that state holds, with its own
     `Context` (`poll_unpin(cx)` inside a short `with_state` closure; polling a oneshot neither
     awaits nor calls a port). That registers its waker, so a firing wakes it even when no frame,
     flush or tick ever follows. A sync entry that arms a new timer wakes the task directly, so
     the task polls the new receiver (step 9, "Waking the mailbox"). On waking, the task runs the
     same `catch_up`. Without this an idle actor would
     strand its last batch, its acknowledgement and its tick (seam tests 4b and 4c).
4. **One JavaScript promise per batch.** Every frame a TypeScript session hands over while a batch
   is open gets that batch's promise. The TypeScript makes one per frame (`actor.ts:336`), but no
   caller compares them, and all of them settle at the same point with the same outcome. A
   256-frame batch then costs one napi deferred instead of 256. The handle avoids converting the
   frame object, but the binding still reads each frame's envelope fields one by one, so the bench
   measures both sparse batches (one frame each) and full ones (256), with the shell's encoding and
   Rust's parsing included (Benches). The paths that settle at once (a stale generation, a
   poisoned actor, a full mailbox) get their own promise, as today.
5. **A JavaScript acknowledgement ends the pump turn.** Continuation order is kept. In TypeScript
   a batch's acknowledgement continuation (the session's `committed` step, which emits the
   runtime command metadata only while the generation is current,
   `engine/sessions.ts:685`–`:697`) runs before the next mailbox op, so an exit queued behind the
   batch (`:702`, an `enqueue`) cannot retire the generation first. A promise settled from the pump
   has its continuations run only when the pump's napi call returns. So when an op settles a
   batch acknowledgement that has a JavaScript promise, the mailbox task asks the executor to end
   the turn (correction 9): no further runnable starts, the pump returns `Rearm`, the microtasks
   run, and the next op runs in the next macrotask. An acknowledgement with only native senders
   does not end the turn. The cost is one macrotask per JavaScript-acknowledged batch, and the
   bench reports it.
6. **Facts cross as JSON.** A TypeScript translator's facts reach Rust as one `JSON.stringify` per
   batch, parsed with `ace_json`. That drops what `JSON.stringify` drops (fields set to
   `undefined`), and nothing downstream can tell: every consumer either stores the facts as JSON
   or tests a field for truthiness (`raw.ts:33`'s `"raw" in fact.draft && fact.draft.raw`).
7. **Status change is compared by value.** `actor.ts:400` compares the status object by
   identity. `@ace/core` replaces `state.status` only when the new status is not `equal` to it
   (`core/src/status.ts:459`–`:461`), so identity changes exactly when the value does, and Rust
   compares values.

## Corrections to E5.1

**Fixed in E5.1's open review, not by E5.2** (owner decision 7). E5.2 relies on them
and does not edit them:

1. **`flush` seals and flushes actors.** `Engine.flush` calls `actor.flush()` on every actor
   before and after the worker wait (`index.ts:1414`, `:1416`), and that is what seals pending
   frames and flushes the live buffer. E5.1's `flush_to_quiescence` (`lib.rs:358`) only checks
   quiescence. It calls the declared `actor::flush_all(core, exclude)` at those two points, and
   E5.2 fills that function in.
2. **`flush` raises `flush_depth`** for its whole run, as `index.ts:1407` does (`start_flush`,
   `lib.rs:536`), because the actor's `draining()` reads it to seal at once (`actor.ts:342`).
3. **Close's actor steps**: the declared `actor::close_flush(core)` and `actor::close_stop(core)`
   at `index.ts:1439`–`:1442` and `:1459`–`:1463`'s places, under the 4.5 s deadline. E5.2 fills
   them in.
4. **Waker growth.** `register_waker` (`lib.rs:321`) gains `unregister_waker`. Actors are the
   first to register, so growth starts with E5.2, and E5.2 calls `unregister_waker` when an actor
   is dropped.
5. **The wake log** (`Core.wakes`, `record_wake`, `lib.rs:338`) already grows with every wake. It
   becomes probe-only or bounded.

If E5.1 merges without one of these, E5.2 stops and reports it; it does not patch E5.1's files.

**E5.2's own seams in E5.1's files** (an E5.1 reviewer signs off each commit):

6. **The actor's dependencies need a home outside `State`.** Add one field to `Core`:
   `pub actor_deps: RefCell<Rc<actor::ActorDeps>>`, set to `actor::ActorDeps::production(..)` in
   `Engine::new`. It holds ports, so it cannot live in `State` (E5.1 step 4); the probe replaces
   it (step 15).
7. **The probe hook's signature.** E5.1's `attachSession()` takes no arguments
   (`testing.ts:41`, `:245`) and its binding stub is `probe_attach_session` (`probe.rs:215`).
   E5.2 replaces both with the signature in step 15, deletes the stub from `probe.rs` and adds
   `#[cfg(feature = "engine-probe")] pub mod probe_actor;` to `engine/mod.rs`. The E5.1 brief
   said `probe_actor.rs` was declared; it was not.
8. **The live buffer's handle.** The engine reaches the connection's one live buffer the way it
   reaches the shared transaction stack (step 16). The facade's constructor
   (`native-engine/engine.ts`) calls `liveStorePort(store, native)` from `native-engine/frames.ts`,
   one line, and that function's unsubscribe joins the facade's terminal cleanup.
9. **Ending a turn on request.** `Executor::end_turn()` (`executor.rs`) sets a `Cell<bool>` that
   the pump checks between polls: once set, no further runnable starts, the claim moves to
   `Scheduled`, and `pump` returns `Rearm` (the same path as a spent budget), clearing the flag.
   The executor test table gains a row: "a task that ends the turn stops the turn after its poll,
   and the rest runs in the next one".

Nothing else in E5.1's files changes.

## The TypeScript and where each part goes

All TypeScript paths are in `apps/daemon/src/engine/`, all Rust paths in
`native/daemon/crates/ace-engine/src/`. "Owner" is the item whose trait method the Rust calls
(step 6).

| TypeScript                                                                            | Rust                                                                                   |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `actor.ts:22` `keepsTimer`                                                            | `actor/timer.rs` `keeps_timer`                                                         |
| `actor.ts:31`–`:42` `EngineClock`, `systemClock`                                      | stay TypeScript (imported by 30 files outside the engine); the clock is E5.1's port    |
| `actor.ts:52`–`:147` fields and constructor                                           | `actor/state.rs` `Actor`, `Actors` (step 7)                                            |
| `actor.ts:84`–`:113` `outputFlow`, `updatePressure`                                   | `actor/flow.rs` `paused`, `wait`, `update_pressure`                                    |
| `actor.ts:149` `retireGeneration`                                                     | `actor/state.rs` `retire_generation` (then `ActorLinks::expire`, E5.5)                 |
| `actor.ts:154`–`:190` `retainInput`, `releaseInput(s)`, `observeInputs`               | `actor/leases.rs`; the release effect is `ActorLinks::release_leases` (E5.5)           |
| `actor.ts:191`–`:252` `enqueue`, `accept`, `acceptOperation`, overflow                | `actor/mailbox.rs` `enqueue`, `accept_operation`; overflow in `actor/failure.rs`       |
| `actor.ts:254`–`:266` `runWhenWritable`                                               | `actor/mailbox.rs` `run_when_writable`                                                 |
| `actor.ts:268`–`:301` `quarantine`, `fail`                                            | `actor/failure.rs` `quarantine`, `fail`                                                |
| `actor.ts:303`–`:352` `frame`                                                         | `actor/intake.rs` `frame`                                                              |
| `actor.ts:353`–`:443` `sealFrames`                                                    | `actor/intake.rs` `seal` and `actor/fold.rs` `fold_batch`                              |
| `actor.ts:448`–`:491` `translateBatch`, `writeCursorRecord`                           | `actor/fold.rs` `translate_batch`; the record is `ActorRepo::cursor_record` (E5.8)     |
| `actor.ts:492`–`:516` `translateFrame`                                                | `actor/fold.rs` `translate_frame`                                                      |
| `actor.ts:517`–`:528` `syncQueue`, `apply`                                            | `actor/fold.rs` `sync_queue`, `apply`                                                  |
| `actor.ts:529`–`:582` `disarm`, `schedule`, `releaseAt`                               | `actor/timer.rs`                                                                       |
| `actor.ts:583`–`:608` `backlog`, `flush`, `stop`                                      | `actor/mailbox.rs` `backlog`, `flush`; `actor/state.rs` `stop`                         |
| `index.ts:528`–`:562` `actor(id)` (creation, eviction at capacity)                    | `actor/mod.rs` `get_or_create`                                                         |
| `index.ts:367`–`:369` live-write quarantine subscription                              | shell `native-engine/frames.ts` `liveStorePort`, into `actor::quarantine`              |
| `index.ts:391` the repository's observe hook into `observeInputs`                     | `actor::observe_inputs`, called by E5.3's apply                                        |
| `frame-envelope.ts:12` `frameEnvelopeError`                                           | `frames/envelope.rs` `envelope_error`                                                  |
| `delta-batch.ts:4` `coalesceFacts`                                                    | `frames/coalesce.rs` `coalesce_facts` (E5.3's `provider-facts` calls it)               |
| `raw.ts:8` `capFact`                                                                  | `frames/raw.rs` `cap_fact` (E5.3 calls it)                                             |
| `raw.ts:43` `readRawBlob`                                                             | `frames/raw.rs` `read_raw_blob` (E5.3's facade member calls it)                        |
| `fact-bytes.ts:2` `jsonStringBytes`, `:27` `streamedFactsBytes`                       | `frames/bytes.rs` `json_string_bytes`, `streamed_facts_bytes`                          |
| `attachment-echo.ts:8`–`:72` `pathHash`, `imageHash`, `contentHash`, `attachmentEcho` | `frames/attachments.rs`                                                                |
| `attachment-payload.ts:2` `attachmentPayload`                                         | `frames/attachment_payload.rs` `attachment_payload`                                    |
| `attachment-correlations.ts:10`–`:63` `AttachmentCorrelations`                        | `frames/correlations.rs` `Correlations` (E5.5's delivery calls `remember`)             |
| `stream-facts.ts:7` `streamFacts`                                                     | `frames/stream.rs` `stream_facts` over the `StreamSnapshot` trait (E5.3 implements it) |

`ace-engine/src/actor.rs` and `frames.rs` become `actor/mod.rs` and `frames/mod.rs` (the module
paths stay `crate::actor` and `crate::frames`). No file over 400 lines; the split above keeps each
under about 250.

## Steps

### 1. Byte measures (`frames/bytes.rs`)

All three count bytes of JavaScript strings, whose unit is UTF-16. Use `ace_json::JsString::units()`
throughout, never `str::len`, since a JavaScript string may hold lone surrogates.

- `json_string_bytes(&JsString) -> usize`: `fact-bytes.ts:2`–`:22`, unit for unit. The starting
  2 is the quotes. `"` and `\` count 2, other units ≥ 0x20 and < 0x80 count 1, `\b \t \n \f \r`
  count 2, other controls count 6, < 0x800 counts 2, a surrogate pair counts 4, a lone surrogate
  counts 6 (`\udxxx`, as `JSON.stringify` writes it), and the rest count 3.
- `utf8_len(&JsString) -> usize`: what `Buffer.byteLength(string)` returns, with a lone surrogate
  counted as 3 (Node encodes it as U+FFFD). `coalesce_facts` uses it (step 3). It is not
  `json_string_bytes - 2`.
- `streamed_facts_bytes(&[Value]) -> usize`: `fact-bytes.ts:27`–`:41`. The array brackets and
  commas count `2 + max(0, n − 1)`. Per fact, the braces count 2, then for each key in order a
  comma when it is not the first, `json_string_bytes(key) + 1`, and the value's size: a string
  through `json_string_bytes`, anything else as `ace_json::to_string(value).len()`. It never
  serializes the string fields. The TypeScript skips values `JSON.stringify` drops (`undefined`,
  functions, a `toJSON` that returns `undefined`). An `ace_json::Value` cannot hold those, so the
  skip has no Rust counterpart; facts reach Rust already as JSON.
- **(b) cases** (`fact-bytes.test.ts`, 11 rows): move into `#[cfg(test)] mod tests` as one table
  asserting `streamed_facts_bytes(facts) == ace_json::to_string(&Value::Array(facts)).len()`.
  Seven rows move as they are. Four hold JavaScript-only values ("an absent optional field",
  "fields serialised as nothing or as null", "a field serialised through toJSON", and NaN in that
  row), and each moves as the JSON those values serialize to: the field absent, `null`, or the
  string. The expectation stays the same (bytes equal the JSON's length). The commit says which
  rows were translated and why.

### 2. The envelope (`frames/envelope.rs`)

```rust
/// One envelope field as the binding found it on the JavaScript object, or as a native frame has it.
pub enum Field { Absent, Null, Number(f64), String(JsString), Object, Other }
pub struct Envelope { pub is_object: bool, pub seq: Field, pub t: Field, pub dir: Field,
    pub channel: Field, pub payload: PayloadField, pub usage_account: AccountField }
pub enum PayloadField { Absent, Certified, NotCertified }
pub enum AccountField { Absent, NotObject, Object { id: Field, billing_mode: Field } }
pub fn envelope_error(envelope: &Envelope) -> Option<&'static str>;
```

The checks and their order are `frame-envelope.ts:13`–`:26`. `seq` must be a safe integer ≥ 0 (an
integral `f64` with `|x| ≤ 2^53 − 1`); `t` a finite number ≥ 0; `dir` one of `send`, `recv`,
`stderr`, `note`; `channel` a string; `payload` absent or `Certified` (the shell's
`ProviderPayload.is`, a JavaScript brand check); and `usageAccount` absent, or an object whose
`id` is a string of 1 to 512 UTF-16 units and whose `billingMode` is `api`, `subscription` or
`unknown`. The binding reads the fields with `get_named_property` and classifies their JavaScript
types into `Field`; that is translation, not behaviour (rule 7). A native `Frame` builds its
`Envelope` from its typed fields, so a malformed native frame fails the same way.

**(b) cases** (`frame-envelope.test.ts`, 4 accepted, 11 rejected): one table each, same names,
with the inputs written as `Envelope` values. `null as unknown as Frame` is `is_object: false`.
`{ payload: { data, bytes } }` that ace did not make is `NotCertified`.

### 3. Coalescing and capping (`frames/coalesce.rs`, `frames/raw.rs`)

- `coalesce_facts(&[Value]) -> Vec<Value>`: `delta-batch.ts:4`–`:35`, unit for unit. Adjacent
  `item.delta`s with the same `agent`, `item` and `field` merge while
  `utf8_len(previous.append) + utf8_len(next.append) ≤ 4096`. A `signal` between two such deltas
  is dropped under the same bound only when **its own `agent` equals the previous delta's** (and
  the next delta's agent, item and field match the previous one's, `delta-batch.ts:13`–`:22`). A
  signal of another agent, or one with no agent, is kept, and so is every other boundary. The merge is
  `{ ...previous, append: previous.append + fact.append }`: clone the previous map and replace
  `append` **in place** (an `ace_json::Map` insert on an existing key keeps its position), so key
  order matches. Join the appends with `JsString::push_js`, never through `str`.
- `cap_fact(cap_raw: &mut dyn FnMut(Value) -> Result<Value, EngineError>, fact: Value, previous: Option<&ToolCall>) -> Result<Value, EngineError>`:
  `raw.ts:8`–`:42`, branch for branch and in that order. The approval redaction uses
  `ace_core::ace_tools::redact_ace_approval` (it returns whether it changed the request, which is
  `raw.ts:14`'s identity check), and a changed request also replaces `raw` with
  `[{"type":"ace.private-input","data":{"redacted":true}}]`. The tool call is normalized with
  `normalize_ace_call`, then `raw` is capped in the first branch that applies. Each spread is an
  in-place replacement. `cap_raw` is the store's `capRaw` (E5.3 passes it).
- `read_raw_blob(conn, id: &str) -> Result<Option<Vec<u8>>, EngineError>`: `raw.ts:43`–`:53`.
  `readRawBlob` is a callable facade member (`index.ts:1402`), so its empty-id error stays exactly
  today's. The facade shell runs the same `z.string().min(1).parse(id)` before it calls the
  binding (a boundary check, ADR 0125), so `readRawBlob("")` throws the same `ZodError`. Rust
  still refuses an empty id, with `EngineError::InvalidRawBlobId`, which is unreachable from
  JavaScript. Look
  in `blobs` first, then `engine_raw_blobs`, as `SELECT bytes FROM … WHERE id=?` through
  `ace-store`'s statement cache. A value that is not a blob is `Invalid stored raw blob`.

### 4. Attachments (`frames/attachments.rs`, `frames/attachment_payload.rs`, `frames/correlations.rs`)

- `path_hash(&JsString) -> Option<String>`: the regex `(?:^|[\\/])([a-f0-9]{64})(?:\.[a-z]+)?$`,
  written as a small matcher over the units with no new crate: an optional `.` plus lowercase
  extension at the end, 64 lowercase hex before it, and either the start or `/` or `\` before those.
- `image_hash(&JsString) -> Option<String>`: `attachment-echo.ts:11`–`:21`. Try
  `ace_adapter_api::util::binary_elision::elided_digest` on the value, or on the part after the
  first comma when it starts with `data:`. Its 420-unit limit is in UTF-16 units; check that E1's
  port counts them so. Otherwise take the data URL's base64 (`util::data_url::base64_data_url`)
  or the value itself. Reject it if empty, if longer than 6 MiB in units, or if
  `util::data_url::is_base64` says no. Otherwise return the lowercase hex SHA-256 of the decoded
  bytes. Decode with the `base64` crate configured to accept exactly what Node's
  `Buffer.from(…, "base64")` decodes for strings `is_base64` admits (padding optional). Add a test
  row for a value without padding.
- `attachment_echo(fact: Value, lookup: &mut dyn FnMut(&str) -> Result<Option<Value>, EngineError>) -> Result<Value, EngineError>`:
  `attachment-echo.ts:30`–`:72`. Only user `message` upserts and reconciles are touched. The
  `verified` cache is per fact, and `attachments` is an `IndexMap` in first-match order: parts
  first, then the raw walk. Parts whose content hash matched are removed. In each `raw` entry
  that has `data`, `data` goes through `attachment_payload` with the key rule `path`→`path_hash`,
  `url`/`uri`→`path_hash` else `image_hash`, `data`→`image_hash`, and a matched string becomes
  `attachment:<sha256>`. With no match, the original fact is returned untouched. Otherwise
  `draft.parts`, `draft.attachments` and `draft.raw` (raw only when the draft had one) are
  replaced in place or appended, in that order.
- `attachment_payload(value: &Value, replace: &mut dyn FnMut(&str, &JsString) -> JsString) -> Value`:
  `attachment-payload.ts`, iterative on a heap stack (no recursion; depth is unbounded, as
  `ace_json` promises). **The visiting order is the TypeScript's, because `replace` has effects:**
  `sanitize`'s `find` inserts into the `attachments` map, and that map's order is the output's.
  The stack is LIFO, and each container pushes its children in forward order
  (`attachment-payload.ts:25`–`:31` for arrays, `:39`–`:50` for objects). Siblings are therefore
  visited **last first**, each subtree depth-first before the sibling before it. Rust uses one
  `Vec` stack the same way, pushing children forward and popping from the end. Visiting forward
  changes the attachment order for a payload that echoes two uploads, and the test below catches
  it. The output keeps each container's original key and element order, whatever the visiting
  order. A string inside an array gets the key `""`, not its parent's. `__proto__` is an ordinary
  key.
- `Correlations` over the connection, `attachment-correlations.ts:10`–`:63`:
  - `open(conn)` runs the TypeScript's DDL text **byte for byte**, the same string with the same
    whitespace, in one transaction. SQLite stores that text in `sqlite_master`, so a home created
    by either backend has the same schema text. Every statement is `IF NOT EXISTS`, so on an
    existing home it does no history-sized work (ADR 0170). It runs where the TypeScript runs it:
    when the repository is built (E5.3 calls `Correlations::open`).
  - `remember(thread, intent, attachments)`: at most 64 entries, each upserted as in `:30`–`:34`.
    The TypeScript writes `JSON.stringify` of `Attachment.array().max(64).parse(attachments)`
    (`:28`), which is schema order with unknown keys dropped. Rust does that projection itself
    with the same function `get` uses, never trusting the caller's order, and refuses more than
    64 entries or a non-conforming entry before writing anything. Delivery (E5.5) calls `remember`
    and `remember_paths` in their own transaction **before the send**, as `delivery.ts:149`–`:153`
    does, so an echo that arrives right after the send always finds its correlation.
  - `get(thread, hash) -> Result<Option<Value>, EngineError>`: the TypeScript runs the stored JSON
    through `Attachment.parse`, which returns the **schema's key order** and drops unknown keys
    (rule 8). Rust rebuilds the map in `Attachment`'s order (`packages/protocol/src/context.ts:138`–`:157`:
    `sha256, bytes, mimeType, name, kind, delivery, width, height, thumbnailAvailable`), keeping
    only those keys that are present. A row that is not that shape is
    `EngineError::InvalidStoredAttachment` (owner decision 5).
  - `remember_paths` (≤ 64, path 1 to 4096 units) and `can_read` (the thread exists, is not
    deleted, and has the path) as `:42`–`:62`. Nothing in the engine calls `can_read` today
    (`services/cli-requests.ts` takes its own `canRead`), so port it, and E5.5 checks whether
    anything needs it.

### 5. The streaming fold (`frames/stream.rs`)

`stream-facts.ts` runs the canonical reducer over a snapshot the repository owns. Rust fixes the
snapshot's interface as a trait, and E5.3 implements it on its snapshot:

```rust
pub trait StreamSnapshot {
    fn begin(&mut self);
    fn deadline(&self) -> Option<Option<i64>>;             // FactBatch's stable-signal deadline
    fn state(&mut self) -> &mut ace_core::ThreadState;
    fn prepare(&mut self, fact: &Value) -> Prepared;        // finished by `finish`, on every path
    fn finish(&mut self, prepared: Prepared);
    fn delta(&mut self, fact: &Value);
    fn remember(&mut self, fact: &Value, emitted: &[Event]);
    fn update_deadlines(&mut self, facts: &[Value], events: &[Event], now: i64);
    fn retain_changes(&mut self, events: &[Event]);
}
pub fn stream_facts(snapshot: &mut dyn StreamSnapshot, facts: &[Value], now: i64, ids: &mut dyn IdSource) -> Vec<Event>;
```

The order is `stream-facts.ts:13`–`:31`: `begin`, a `FactBatch::new(Some(deadline))`, and per fact
`prepare`, `apply`, then `delta` if the fact is an `item.delta` that emitted one, `remember`,
`finish`. After the loop come `flush`, `update_deadlines` and `retain_changes`. `finish` runs even
when `apply` returns `None`. A test with a recording snapshot checks the call order, including
`finish` after a rejected fact. That test is new (the TypeScript has none) and the commit says so.

### 6. The actor's dependencies (`actor/deps.rs`)

```rust
pub struct ActorDeps {
    pub repo: Rc<dyn ActorRepo>,
    pub links: Rc<dyn ActorLinks>,
    pub live: Rc<dyn LiveStore>,
    /// Each actor's translator, set when a session attaches (E5.6, or the probe), cleared with it.
    pub translators: RefCell<HashMap<ThreadId, ActorTranslator>>, // Js(JsTranslator) | Native(Box<dyn Translator>)
}
impl ActorDeps { pub fn production() -> ActorDeps; } // NotPorted bodies until each owner lands
```

Every method takes `&Core` where it needs the store or state, and is called with no `with_state`
borrow held (E5.1 re-entrancy rule 2). `ActorRepo`, each method with its TypeScript and its owner:

| Method                                                                 | TypeScript                                                                                                                               | Owner |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `status(thread) -> Value`                                              | `repo.requireState(id).status`, `actor.ts:375`, `:400`                                                                                   | E5.3  |
| `route(thread) -> Route { provider, backend }`                         | `requireState(id).config.provider`, `repo.backend(id)`, `:371`–`:373`                                                                    | E5.3  |
| `quiescent(thread) -> bool`                                            | `repo.quiescent(requireState(id))`, `:461`                                                                                               | E5.3  |
| `running_foreground_command(thread) -> bool`                           | `hasRunningForegroundCommand` (`core/src/steering.ts:26`); E5.2 ports it as `actor/rules.rs` over `ace_core::ThreadState`, E5.3 calls it | E5.3  |
| `stream(thread, facts, now) -> bool`                                   | `repo.stream`, `repository.ts:363`                                                                                                       | E5.3  |
| `apply(thread, facts, now, generation)`                                | `repo.apply`, `repository.ts:413`                                                                                                        | E5.3  |
| `deadline(thread, translator: Option<i64>)`                            | `repo.deadline`, `actor.ts:552`                                                                                                          | E5.3  |
| `schedule_view(thread) -> Option<ScheduleView { done, left_running }>` | `repo.state(id)`, `:537`–`:545`                                                                                                          | E5.3  |
| `evict(thread)`, `clear_incomplete_blobs(thread)`                      | `:279`, `:524`                                                                                                                           | E5.3  |
| `root_agent_id(thread)`                                                | `index.ts:856`–`:859`                                                                                                                    | E5.3  |
| `engine_queue_fact(thread) -> Option<Value>`                           | `repo.engineQueueFact`, `:518`                                                                                                           | E5.4  |
| `queue_paused(thread) -> bool`                                         | `repo.queue.get(id).paused`, `:470`                                                                                                      | E5.4  |
| `queued_count(thread)`                                                 | `repo.queuedCount`, `index.ts:799`                                                                                                       | E5.4  |
| `latest_generation(thread)`                                            | `max(pending.latestGeneration, interactions.latestGeneration)`, `index.ts:556`–`:559`; see below                                         | E5.4  |
| `mark_yielded_end(thread, facts) -> Vec<Value>`                        | `markYieldedEnd`, `:466`–`:472`; with no yield recorded it returns the facts unchanged, which is correct before E5.5 sets any            | E5.5  |
| `session_instance(thread) -> Option<String>`                           | `repo.session(id).instanceId`, `:498`                                                                                                    | E5.6  |
| `reserved_slot(thread)`, `retiring_count()`                            | `index.ts:533`–`:536`                                                                                                                    | E5.6  |
| `released_thread(thread) -> bool`                                      | `releasedThread(getThread(id))`, `index.ts:555`; a stored-row read, moved forward so E5.6 can create actors                              | E5.3  |
| `cursor_record(thread, entries)`                                       | `writeCursorRecord`, `:475`–`:491`; called only with a non-empty journal (below)                                                         | E5.8  |

Three of these are on the path every actor takes, so their owners must not leave them unported
past E5.6, which is the first item that opens real sessions:

- **`latest_generation`** (owner decision 4). Actor creation reads it, so E5.4
  implements it without waiting for E5.7's ledger behaviour. It takes the indexed maximum of both
  sources on the same connection: `pending.latestGeneration` and
  `SELECT COALESCE(MAX(generation),0) FROM engine_interaction_requests WHERE thread_id=?`
  (`interaction-ledger.ts:49`, served by `engine_requests_generation`). The legacy backfill writes
  `NULL` generations (`:23`–`:30`), which `MAX` ignores, as today. E5.4 also makes sure the ledger
  table and its index exist on a fresh home, with the TypeScript's DDL text byte for byte
  (`:11`–`:18`), before the first actor is created.
- **`released_thread`** moves to E5.3. It is a read of the stored thread row, and E5.10 would be
  too late for E5.6's proof.
- **`cursor_record`** is called only when the batch's journal is non-empty. Only a Cursor SDK
  thread ever has entries (`actor.ts:457`–`:464`), and the TypeScript's `trimStep` runs only then
  (`:490`), so every other thread never reaches E5.8's unported method.

`ActorLinks`, the effects elsewhere:

| Method                                      | TypeScript                                                                              | Owner |
| ------------------------------------------- | --------------------------------------------------------------------------------------- | ----- |
| `wake(thread)`                              | `() => this.wake(id)` (`index.ts:547`, `:1256`)                                         | E5.4  |
| `abort_session(thread, drop_session: bool)` | `lifetime.abort()`; with `true` also `session = translator = undefined` (`:206`–`:208`) | E5.6  |
| `expire(thread, generation)`                | `onRetire` → `delivery.expire` (`index.ts:553`)                                         | E5.5  |
| `diagnostic(thread, raw)`                   | `this.diagnostic` → `onProviderDiagnostic` (`:495`)                                     | E5.6  |
| `release_leases(tokens)`                    | each lease's `release()` (`:159`–`:163`)                                                | E5.5  |

`LiveStore`, the store's write gates and live buffer, which E5.2 owns because the
acknowledgement depends on them (step 16 is the whole of it): `writable_now()`, `writable()`,
`history_writing()`, `live_write_blocked()`, `prepare_live_write(bytes)`,
`buffer_live_write(tx, thread, events, at, snapshot)`, `flush_due()`, and
`is_store_retry(&EngineError) -> bool`. That last one is `isStoreRetry` (`store-busy.ts:27`): for
an `ace_store::Error` it means busy or disk full; for a JavaScript error a port threw, the shell's
function decides. E5.3's `stream` calls `prepare_live_write` and `buffer_live_write`, with its
`persist` and `committed` steps as the snapshot (step 16).

`production()` builds `ActorDeps` from three `Unported` structs. Each method returns
`EngineError::not_ported("<method>", "E5.<n>")`. `wake`, `expire` and `diagnostic` return nothing,
so they report it once per call through `ports.report`; none is a silent no-op. `LiveStore`'s
production implementation is E5.2's own (step 16). Each owner replaces only its
methods' bodies in `deps.rs`, so no two items edit the same function.

### 7. The actor's state, and `with_state` (`actor/state.rs`, `actor/mod.rs`)

```rust
#[derive(Default)]
pub struct Actors { by_thread: IndexMap<ThreadId, Actor> } // insertion order is the TS Map's
pub struct Actor {
    pub id: ThreadId,
    pub generation: u64,
    pub poisoned: bool,
    pub persistence_failed: bool,
    pub idle_since: Option<f64>,
    pub idle_due: bool,
    pub release_requested: bool,
    pub session_attached: bool,            // `actor.session !== undefined`, set by E5.6 or the probe
    leases: IndexMap<u64, Lease>,           // Lease { token: u64, run_id: Option<String> }
    queued: usize, queued_bytes: usize,
    pending: Vec<Pending>,                  // Pending { frame: FrameRef, generation, bytes }
    pending_bytes: usize,
    pending_ack: Option<BatchAck>,          // the open batch's acknowledgement (decision 4)
    batch_timer: Option<Timer>,             // key + `fired` receiver, polled by the mailbox task (decision 3)
    overflowed: bool, pressure: bool,
    drains: Vec<oneshot::Sender<()>>,
    mailbox: VecDeque<Op>,                  // sealed batches and enqueued operations
    running: bool,                          // an op is mid-run (holds `queued` until it ends)
    timer: Option<(Timer, ArmedTimer)>,     // likewise
    stopped: bool,
    mailbox_task: Option<TaskId>,
}
pub enum FrameRef { Js(u32), Native(Box<ace_adapter_api::Frame>) }
```

- **What lives in state.** All of the above is plain data. The translator is not: a JavaScript
  translator is a port, and a native one may be large and is borrowed during translation. It lives
  in `ActorDeps.translators` (step 6) as `(generation, ActorTranslator)`, which whoever attaches
  the session (E5.6, or the probe) sets and clears. **No borrow of that map is ever held across a
  translator call** (ADR 0223 §4, "JS ports during a step"), because a JavaScript translator can
  re-enter the engine and attach or detach a session. So a translation, tick or
  `next_deadline` first takes the translator **out** (`borrow_mut().remove(thread)`, the borrow
  ending with the statement), calls it with no borrow held, and puts it back **only if** the map
  has no entry for the thread and the actor's generation still equals the one stored with it.
  Otherwise the session was replaced or retired during the call, and the taken translator is
  dropped, which leaves the new one in place. While it is out, a lookup finds no translator,
  which is what TypeScript's `this.translator?.` gives for a detached session. The session, its
  lifetime and the steer yield are E5.6's and E5.5's state in their own `State` fields, keyed by
  thread.
- **The rules.** Every read or change of an `Actor` is one `core.with_state(|s| …)` closure that
  copies out what the next step needs and returns. No closure calls an `ActorRepo`, `ActorLinks` or
  `LiveStore` method, a translator, `defer`, `spawn` or a port. The shape of every step is: a
  closure decides and takes (for example `seal` moves `pending` into a new `Op` and returns
  whether to wake); then the effects run outside it; then a second closure applies the results and
  **re-checks** `stopped`, `poisoned` and `generation`, exactly where the TypeScript reads them
  after a call (`actor.ts:369` filters by the generation at run time, `:433` reads `poisoned` and
  `overflowed` when the acknowledgement settles). A `Reentrant` error from `with_state` is a bug.
  It is reported, the op fails like any other error (`fail`), and nothing panics.
- `get_or_create(core, thread)` is `index.ts:528`–`:562`. If the map is at
  `max_active_threads + retiring_count()`, it stops, evicts and removes the oldest actors without
  a reserved slot, in insertion order, until there is room. Still full is
  `Engine actor capacity exceeded`. A new actor takes `released_thread` and `latest_generation`.
- **Waking the mailbox, and what a rollback takes with it.** Mailbox work falls into two kinds,
  and only the first may bypass `defer`:
  - **Work that does not depend on the enclosing transaction.** This covers a batch sealed from
    frames a session handed over, a batch sealed by its timer or by a flush, a timer's tick, and
    arming a timer. A frame was received from the provider whatever the caller's transaction does,
    and its acknowledgement already waits on its own fold, which runs later outside any transaction
    (step 9). Such work is pushed at once and wakes the mailbox task **directly**
    (`waker.wake_by_ref()` on the waker it registered). A direct wake only schedules a poll: the
    task runs in a later pump, and the pump never runs inside a transaction, so it runs after the
    enclosing transaction has committed or rolled back. If that transaction rolls back, the batch
    is still folded and acknowledged, as TypeScript's `tail` would fold it (`actor.ts:198`–`:252`).
  - **Work that depends on the receipt**, which is every generic `enqueue(run)` made while a
    transaction is open (a command's or a port's follow-up, `rootAgent`'s tick, a stop or steer
    step). Its closure may have captured state the transaction has not committed. So `enqueue`
    seals the pending frames at once (they are the first kind). Then, inside an open transaction,
    it pushes a **staged slot** at the call's place in the mailbox, which keeps its order, and
    hands the op to `core.defer(Deferred::Spawn(Lane::Work, admit))`. **A staged slot counts toward
    nothing**: not `queued`, not `queued_bytes`, not pressure, and not the overflow check. So
    uncommitted work can never overflow the mailbox or end a session. `admit` owns the op. When the
    outermost transaction commits, it is released and spawned, and when it runs (in a later pump,
    on committed state) it does exactly what TypeScript's `accept` does at the call
    (`actor.ts:195`–`:252`): the stopped and overflowed checks, then the capacity check against
    `queued` and `queued_bytes` **as they are now**, then either the count, `update_pressure` and
    filling the slot, or `overflowed`, the overflow op queued at the tail, and the slot
    discarded. Then it wakes the mailbox. If the transaction rolls back, `admit` is dropped, and
    its guard marks the slot discarded and wakes the mailbox, which skips the slot. Nothing was
    counted, so nothing is subtracted. A parked mailbox that reaches a
    slot still pending waits for it. Outside a transaction, `enqueue` pushes the op at once, as
    the first kind does.
- **Capacity and provisional actors: the slot is reserved at the call.** The call returns exactly
  what TypeScript returns (`index.ts:528`–`:562`), and once it has returned an actor, promotion at
  commit cannot fail. Capacity is counted as
  `occupied = committed actors + held reservations − pledged victims`, against
  `room = max_active_threads + retiring_count()`.
  - **Outside a transaction**: TypeScript's loop exactly. Evict the oldest actors with no
    `engine_slots` row (`repository.ts:539`) until `occupied < room`, else throw
    `Engine actor capacity exceeded`. The new actor is committed at once.
  - **Inside an open transaction**: the same loop picks the same victims, in the same order, with
    the same predicate, plus "not provisional, not already pledged". It does not evict them. It
    **pledges** each one to this transaction, which takes it out of `occupied`. If the loop cannot
    reach `occupied < room`, the call throws `Engine actor capacity exceeded`, exactly where
    TypeScript throws, and pledges nothing. Otherwise the call **holds one reservation** for the
    new provisional actor and returns it. The reservation and the pledges belong to the
    transaction's after-commit token (the deferred mailbox task below), so a second creation in
    the same transaction, or in a nested or later one, sees them in `occupied` and can never be
    given the same slot.
  - **On commit**, before any other entry can look at actors, the pledged victims are evicted
    (`stop`, `repo.evict`, removed from `Actors`: memory only, what TypeScript did at the call),
    and the provisional actor becomes committed, using the slot its reservation held. This runs
    **lazily, at the first of** the promoted task's first poll or any synchronous actor entry
    (`get_or_create`, `frame`, `enqueue`, `liveThreadIds`, `workload`), which first completes
    every committed transaction's pending promotions in commit order. A victim that something
    asks for after the commit is therefore already evicted and is recreated fresh, as TypeScript
    would recreate it after evicting it at the call. Promotion only moves a slot it already holds,
    so it cannot fail.
  - **On rollback** the deferred task is dropped. Its guard releases the reservation, unpledges
    the victims (which were never touched and carry on) and discards the provisional actor
    (below). Nothing was evicted, so nothing is lost.
  - **Inside the transaction itself**, a lookup of a pledged victim returns it as it stands, not
    evicted. TypeScript would have rebuilt it from the store. The difference is in-memory only
    (an idle timer re-armed, `idleSince` kept), lasts only until the transaction ends, and the
    commit then evicts it as above.
  - **If a reservation is ever found unusable at promotion** (an invariant break, never a normal
    path), the actor is not discarded quietly. Every pending acknowledgement **rejects** with
    `Provider frame failed to commit`, so the session's tracker stops intake (ADR 0223 §7 rule 4)
    and nothing reads as a false success. Every op staged or queued for it is failed, not dropped:
    it is reported through `onError` as `Engine actor capacity reservation lost for <thread>`, and
    the durable work behind it (a send receipt is a durable admission, `handler.ts:536`–`:549`;
    intents and queue rows stay as committed) is retried by `links.wake(thread)`, so the workers
    redeliver it through a fresh actor once there is room. Seam test 17d forces this path through a
    probe hook.
- **A new actor's first poll.** `get_or_create` inside an open transaction inserts the actor marked
  `provisional` and defers its mailbox task: `core.defer(Deferred::Spawn(Lane::Work, mailbox))`.
  On commit the task is spawned, registers its waker and gets its first poll in a later pump. On
  rollback the deferred future is dropped, and its guard removes the provisional actor from
  `Actors` and unregisters nothing, since nothing was registered. A rolled-back provisional actor
  has no session (sessions attach after their own commits), so it holds no frames. If one ever
  holds a pending acknowledgement, the acknowledgement rejects with
  `Provider frame failed to commit` and never resolves `Done`. A discarded actor is never polled and has no waker. Outside a transaction the task is spawned at once. Until its task exists, a direct wake
  of a provisional actor is a no-op; the spawned task's first poll runs `catch_up` and takes
  whatever was queued.
- These are the actor's only exceptions to E5.1's "sync entries start work through `defer`": direct
  wakes of an existing task for work of the first kind, which spawn nothing. The reviewer checks
  that no receipt-dependent op and no actor creation goes through them.
- `stop(core, thread)`: `actor.ts:599`–`:608`. Seal first, set `stopped`, release all leases,
  disarm, clear pressure, resolve every drain. Dropping the actor also unregisters its waker
  (correction 4) and drops its mailbox task.

### 8. Intake and batching (`actor/intake.rs`)

`frame(core, thread, generation, input: FrameInput) -> Ack`, a synchronous entry, in
`actor.ts:303`–`:352`'s order:

```rust
pub struct FrameInput { pub frame: FrameRef, pub envelope: Envelope, pub channel_sdk: bool,
    pub measure: Measure }
pub enum Measure { Certified { bytes: usize }, Bounded(Result<usize, String>) }
pub enum Ack { Done, Rejected(String), Batch(BatchAckRef), AfterFlush(FlushRef) }
```

1. `catch_up` (decision 3).
2. Stopped, or `generation` is not the actor's: `Ack::Done`, and the frame is dropped
   (behaviour.md §4.1).
3. Poisoned: `Ack::Rejected("Provider frame failed to commit")`.
4. `envelope_error` returns a field: enqueue an op that fails with
   `Provider frame envelope is malformed: <field>`, and return `Ack::AfterFlush`, which settles when
   this actor's `flush` does. It **resolves** and does not reject; the session's wrapper turns a
   poisoned actor into the rejection (`engine/sessions.ts:686`, E5.6).
5. An `sdk` channel without `Measure::Certified`: enqueue a failing op with
   `SDK frame lacks matching encoded admission certificate`, `Ack::AfterFlush`. `Measure::Bounded(Err(m))`
   (the shell's `boundedJson` threw) does the same with `m`.
6. Bytes: `Certified { bytes } → bytes + 512`, `Bounded(Ok(n)) → n`. Over `max_frame_bytes`:
   a failing op with `Provider frame capacity exceeded`, `Ack::AfterFlush`.
7. `overflowed`: `Ack::Rejected("Provider mailbox capacity exceeded")`.
8. Push onto `pending`, add the bytes, `update_pressure`, arm the batch timer if none is armed
   (`set_batch_timer(1.0)`), and join the open batch's acknowledgement. Then seal at once if
   `flush_depth > 0`, or `queued + pending ≥ max_queued_frames`, or
   `queued_bytes + pending_bytes ≥ max_queued_bytes`, or `pending ≥ 256`, or
   `pending_bytes ≥ 262144`.

`seal(core, thread)` is `actor.ts:353`–`:443` up to the op. It cancels the batch timer and takes
`pending` and its bytes. If either is empty it does nothing. It calls `accept_operation` with
`frames = n` and `bytes`. The op holds the frames, the batch's acknowledgement, whether it was
admitted, and the retry caches of step 10 (`translated`, `streamed`, `status_before`). A refused
op (stopped or overflowed) still settles its acknowledgement after the ops before it, as the
TypeScript's `commit = this.tail` does (`:430`): it is queued as a settle-only marker that
**rejects** with `Provider frame failed to commit` when the mailbox reaches it.

### 9. The mailbox and the acknowledgement (`actor/mailbox.rs`)

- `accept_operation(core, thread, op, bytes, frames) -> bool` is `actor.ts:198`–`:252`. If the
  actor is stopped or overflowed it returns false. If the op would pass `max_queued_frames` or
  `max_queued_bytes`, it sets `overflowed`, queues the overflow op (step 11; it is not counted in
  `queued`) and returns false. Otherwise it adds to `queued` and `queued_bytes`, runs
  `update_pressure`, pushes the op, and wakes the mailbox task directly (step 7, "Waking the
  mailbox").
  `enqueue(run)` is `seal`, then `accept_operation(run wrapped in core.store.atomic, 0, 1)`
  (`actor.ts:191`–`:197`).
- **One mailbox task per actor**, spawned on `Lane::Work` when the actor is created. It registers
  its waker with `core.register_waker(thread, …)` and loops: `catch_up`, then take the front op.
  With no op, it polls both timer receivers (decision 3) and parks. With an op it runs
  `run_when_writable`, then settles. If the settle resolved or rejected a batch acknowledgement
  that has a JavaScript promise, it calls `core.executor.end_turn()` (decision 5, correction 9)
  before it yields. Then it **yields once** before the next op. That yield puts the task back in
  the work queue, so one busy thread never runs two ops in one poll, and the E5.1 fairness rule
  and budget hold across actors. The turn's end is what keeps the order of
  `engine/sessions.ts:685`–`:711`: the session's `committed` continuation, which emits runtime
  command metadata only while the generation is current, runs before an exit op queued behind
  the batch can retire that generation.
- `run_when_writable` (`actor.ts:254`–`:266`), owner decision 3: loop while not
  poisoned. If `live.writable_now()`, run the op. Otherwise await `live.writable()` and go round
  again, so the predicate is **re-checked after the wait, in the turn that runs the op**. The
  wait resolves in one macrotask and the task runs in a later one, and maintenance or history
  publication may have started between them, which is why `Store.write` re-checks at
  `store.ts:888`. `writable_now` is the shared predicate of step 16. On an error
  `live.is_store_retry` accepts, await `ports.set_timer(100.0).fired` and go round again. Any
  other error goes to `fail`.
- **The outermost rule.** Before an op runs, `core.store.is_open()` must be false. The pump never
  runs inside a transaction (E5.1 step 2's `Busy`), so every transaction an op opens is outermost,
  and its commit is the one the acknowledgement waits for. If the check ever finds a transaction
  open, that is `EngineError::NotOutermost`: the op fails visibly through `fail`, and no
  acknowledgement resolves on a savepoint's release (ADR 0223 §4). A reviewer test makes the
  check fail by running an op through the probe inside an open transaction (seam test 11).
- **Settling** happens after the op returns, `actor.ts:431`–`:442`. A finally step comes first:
  subtract the op's frames and bytes from `queued` and run `update_pressure`. Then every
  acknowledgement attached to the op settles: it resolves if the op was admitted and the actor is
  neither poisoned nor overflowed **now**; otherwise it rejects with
  `Provider frame failed to commit`. An op whose run threw went to `fail`, so the actor is poisoned
  and its acknowledgement rejects. The TypeScript's second branch (`:438`–`:440`, the tail
  rejecting) cannot occur, because `fail` catches every error, so it has no Rust counterpart.
- **Where an acknowledgement goes.** `BatchAck { js: Option<u64>, native: Vec<oneshot::Sender<Result<(), String>>> }`.
  `js` is a facade call id (E5.1's `settle_call`), one per batch (decision 4). `native` is one
  sender per native session that fed the batch (E5.6's acknowledgement tracker, which calls
  `ReadGate::fail` on a rejection, ADR 0223 §7 rule 4). A batch may hold both after a session
  switch.
- **When it resolves.** For a committed batch it resolves after the op's last transaction
  committed: `repo.apply`'s own, plus `sync_queue`'s second one on the non-SDK path, or the one
  `atomic` that wraps an SDK or Cursor batch (`actor.ts:389`–`:426`, `:430`). For established
  deltas it resolves after `repo.stream` accepted them into the live buffer and returned true,
  **before the buffer flushes** (porting guide, "For every E5 item"). It never resolves on the
  buffer's flush, and never on a savepoint's release. Its JavaScript continuations run before the
  next op (decision 5).
- `backlog(thread) -> (frames, bytes)` is `queued + pending.len()` and
  `queued_bytes + pending_bytes`.
- `flush(core, thread) -> future` (`actor.ts:589`–`:598`): `catch_up`, `seal`, await `writable`,
  then await until the mailbox is empty with no op running, re-checked after each wait, since an op
  may enqueue another (the TypeScript's `do … while (pending !== this.tail)`), then
  `live.flush_live_writes()`. The task excludes itself (E5.1 re-entrancy rule 9): a flush called
  from inside this actor's own op resolves after that op, not inside it. Wire it to a "mailbox
  idle" `oneshot` list on the actor, never a poll loop.
- `actor::quiescent(state, exclude)` (E5.1's declared check): true when no actor has `pending`
  frames, ops, or a running op, except one running in `exclude`'s task.

### 10. The fold of one batch (`actor/fold.rs`)

`fold_batch(core, thread, op)` is the body of `actor.ts:367`–`:426`, run by the mailbox:

1. `live` = the op's frames whose generation equals the actor's **now** (`:369`). `sdk` = any live
   frame on the `sdk` channel. `cursor_sdk` = `route` is `cursor` with backend `cursor-sdk`.
2. `fold`:
   1. `status_before` is set once, on the first attempt, from `repo.status`.
   2. `translated` is set once: `translate_batch(live frames, cursor_sdk)`. A retry after a rollback
      reuses it and never translates again (translators keep state).
   3. `repo.cursor_record(thread, translated.journal)` runs on every attempt **when the journal is
      non-empty**, because the record rolled back with the rest. An empty journal (every thread but
      a Cursor SDK one) calls nothing, as `actor.ts:476`–`:490` writes nothing and skips `trimStep`.
   4. `tool_boundary`: any fact is an `item.upsert` of a `tool_call` draft, or a `background.started`.
      `command_running` = `tool_boundary && repo.running_foreground_command`.
   5. `streamed` is set once: `!cursor_sdk && repo.stream(thread, facts, now)`.
   6. `settle`: if streamed, `schedule`; else `apply(facts)`. Then, for an SDK batch with an
      unexpected `process.exited`, `links.abort_session(thread, false)`. Then, if the status
      changed (by value, decision 7), or the foreground-command answer changed at a tool boundary,
      or any fact is one of `turn.started`, `input.admitted`, `turn.ended`, `process.exited`,
      `queue.changed`, `limit.cleared`, `interaction.closed`, `background.ended`, `retry`
      (`:402`–`:413`): `sync_queue`, then `links.wake`.
   7. An SDK batch that is neither streamed nor Cursor's runs `settle` inside one
      `core.store.atomic` (`:420`). Otherwise `settle` runs bare.
3. A Cursor SDK batch runs the whole `fold` inside one `core.store.atomic` (`:424`). Otherwise
   `fold` runs bare, outside any transaction.

`translate_batch` (`:448`–`:473`) builds the journal entry for each Cursor SDK frame, with
`begins_turn` = the frame's data is `{kind: "send"}` and `repo.quiescent`, then translates each
frame in order. The result goes through `repo.mark_yielded_end`. The steer yield is applied only
when the queue is not paused (`:470`), and that check is part of E5.5's method.

`translate_frame` (`:492`–`:516`): translate the frame, then report any non-empty diagnostics
through `links.diagnostic`. If any fact is `usage`, the account is the frame's `usageAccount.id`,
else `repo.session_instance`. A usage fact gains `accountId` in place (appended at the end when
absent). It also gains `billingMode` from the frame's account only when the fact has none. Each
fact then goes through `attachment_echo`, whose lookup is `Correlations::get(thread, hash)`.

`apply(facts)` (`:521`–`:528`): `repo.apply(thread, facts, now, generation)`. On a
`process.exited`, `clear_incomplete_blobs` and release every lease. Then `schedule`.
`sync_queue` (`:517`) applies the queue fact if `engine_queue_fact` returns one.

### 11. Failure, overflow and quarantine (`actor/failure.rs`)

- `fail(core, thread, error)` (`actor.ts:271`–`:301`): set `poisoned`. `persistence_failed` is
  true for an `ace_store::Error` from SQLite, or a JavaScript error with a numeric `errcode` or
  `code === "ERR_SQLITE_ERROR"`, which the binding classifies. Then `repo.evict`,
  `links.abort_session(thread, false)` and `ports.report(error)`. Then `repo.apply` of the
  `engine:failure` notice, with the error's message as `text`, `level: "error"` and
  `complete: true`; a failure there is reported, never thrown. Then `links.wake`.
- **Overflow** (`:203`–`:237`): an op that runs when writable, not counted in `queued`. It calls
  `links.abort_session(thread, true)` and `retire_generation` (which calls `links.expire` and
  clears the steer yield through E5.5). It applies the three facts in the order and with the text
  the TypeScript writes: `process.exited` (`deliberate: false`, message
  `Provider mailbox capacity exceeded; resume the thread to recover`), `queue.changed`
  (`source: "provider"`, `count: 0`), and the `engine:overload` error notice. Then it sets
  `overflowed = false` and calls `links.wake`. A failure inside it goes to `fail`.
- `quarantine(core, thread, message)` (`:268`): `fail` unless already poisoned. The shell's
  `liveStorePort` subscribes to `store.onLiveWriteQuarantine` and calls it (`index.ts:367`–`:369`).

### 12. Flow control (`actor/flow.rs`)

- `update_pressure(actor, limits)` (`actor.ts:92`–`:113`). Let `frames = queued + pending.len()`
  and `bytes = queued_bytes + pending_bytes`. Pause when
  `frames ≥ min(256, max(1, floor(max_queued_frames / 4)))` or `bytes ≥ max_queued_bytes / 4`.
  Resume when `frames ≤ min(64, floor(max_queued_frames / 16))` and
  `bytes ≤ max_queued_bytes / 16`. Divide the bytes as `f64`, as JavaScript does (`16 MiB / 4` is
  exact, but an override may not be). Resuming resolves every drain. Between the two thresholds
  nothing changes.
- `paused(core, thread) -> bool` = `pressure || live.history_writing() || live.live_write_blocked()`
  (`:85`–`:86`), read outside `with_state` for the two store calls.
- `wait(core, thread) -> future` (`:87`–`:90`): await `live.writable()`, then, if `pressure`,
  await a drain sender added to `drains`.
- **For a TypeScript session** the context's `outputFlow` is `{ paused, wait }` over these two
  (step 13). **For a native session** the direct path mirrors `paused` into the session's
  `ReadGate` **after each delivered frame**, exactly as the bridge's `mirrorFlow` does
  (`native-session-bridge.ts:120`–`:137`, called per frame at `:165`). On the first paused
  answer it calls `set_paused(true)` once and arms one `wait`. When that resolves, if still
  marked paused, it calls `set_paused(false)`. An unpaused answer while marked paused also calls
  `set_paused(false)`. E5.2 writes this mirror as `actor::NativeFlow` beside `paused` and `wait`,
  and E5.6 calls it. It changes nothing in the gate.

### 13. How frames enter (binding `engine/actor.rs`, `engine/js_translator.rs`; shell `native-engine/actor.ts`, `native-engine/frames.ts`)

**A TypeScript session** (every scripted adapter, Claude, and each provider before its E3). Its
context's `onFrame` and `outputFlow` come from one shell function E5.6 and the probe both use:

```ts
export function actorContext(
  native: NativeEngineBinding,
  frames: FrameTable,
  threadId: string,
  generation: number,
  maxFrameBytes: number,
): Pick<SessionContext, "onFrame" | "outputFlow">;
```

`onFrame(frame)` does only what needs JavaScript, then makes one synchronous binding call
`actorFrame(threadId, generation, handle, frame, certified, measure)`. It stores `frame` in the
`FrameTable` under a fresh handle (released when its batch settles). `certified` is
`ProviderPayload.is(frame.payload) && frame.payload.data === frame.data`. `measure` is
`{ bytes: frame.payload.bytes }` when certified; otherwise
`Buffer.byteLength(boundedJson(frame, maxFrameBytes))`, or that call's error message, the same
call `actor.ts:322` makes. `frame` itself goes to the binding as a `JsUnknown`, so the binding can
classify the envelope (step 2); a non-object frame skips the measure. The binding returns the
batch's promise (decision 4) or a settled one, and the shell attaches
`void promise.catch(() => {})` once per promise object, as `actor.ts:351` does. `outputFlow` is
`{ paused: () => native.actorPaused(threadId), wait: () => native.actorWait(threadId) }`.

**The JavaScript translator** (`engine/js_translator.rs`) is the actor's translator for a
TypeScript session: a reference to the session's `Translator` object and a reference to the
shell's batch helper. `translate_batch(handles)` makes **one** JavaScript call per batch. For each
handle in order, the helper calls `translator.translate(frame, clock.now())` and then
`translator.takeDiagnostics?.() ?? []`, and returns `JSON.stringify([[facts, diagnostics], …])`,
which Rust parses with `ace_json::parse`. So the TypeScript's per-frame `clock.now()` and the
order of `translate` and `takeDiagnostics` are kept. The only change is that `links.diagnostic`
runs for all frames after all translations, and nothing can observe that. `tick(now)` and
`next_deadline()` are one call each. A translator that throws is a `PortError::Threw`, and the op
fails through `fail`, as a throw inside `sealFrames` does today. The Cursor SDK path needs the
frame's data in Rust (`cursor_record`, the `{kind: "send"}` test): the helper returns
`JSON.stringify(frame.data)` beside the facts, only for `channel === "sdk"` frames of a
`cursor-sdk` thread.

**A native session** (E3 done for that provider). The session's tokio task publishes onto its
`EventQueue` (E3.0c step 1). E5.6 drains it on the JS thread with `take_batch(256, 262144)` and,
for each `SessionEvent::Frame`, calls `actor::native_frame(core, thread, generation, event, now, started)`,
which E5.2 writes. It does what the bridge's `frame()` (`native-session-bridge.ts:145`–`:166`)
does, in the same order, without building a JavaScript object:

1. **Payload limits, as `ProviderPayload` enforces them** (`provider-kit/src/payload.ts:4`,
   `:11`–`:40`). The text must be at most `maxProviderPayloadBytes` (1 MiB) of UTF-8, valid JSON
   (`ace_json::parse`), and at most 32,768 value nodes, counted as the constructor counts them
   (every value popped, containers and primitives alike). A frame that fails any of these is
   handled as the bridge handles the throw (`:278`–`:284`): one warning line,
   `native session frame event failed: <message>` with the constructor's message
   (`Provider payload exceeds byte limit`, `Provider payload exceeds structural limit`, or the
   parse error), and the frame is skipped. It gets no acknowledgement, no flow mirror and no
   effect on the actor, and the rest of the batch goes on.
2. `t = max(0, round(now − started))` from the adapter's injected clock, read at delivery on
   the JS thread, as `:157` computes it.
3. `actor::frame` with `FrameRef::Native`, an envelope built from the typed fields, and
   `Measure::Certified { bytes: text.len() }`: the bridge always attaches a certificate whose
   `bytes` is the text's UTF-8 length (`payload.ts:16`), so the count matches byte for byte.
4. The acknowledgement goes to E5.6's tracker, which calls `ReadGate::fail` when it rejects
   (`:163`).
5. `NativeFlow::mirror` (step 12), per frame.

Callbacks and the exit stay behind the frames before them, because E5.6 handles the queue's
events in order and an exit is an `enqueue`, which seals first (ADR 0223 §7 rule 3). The
translator is the provider's Rust `Box<dyn ace_adapter_api::Translator>`. Seam test 12 proves
this path with a Rust test.

**The live store** is step 16.

### 14. Facade members (binding `engine/actor.rs`, shell `native-engine/actor.ts`)

In E5.1's table, E5.2 fills these, each in E5.2's `#[napi] impl NativeEngine` block:

- `liveThreadIds()` (R): the actors' ids in insertion order (`index.ts:1049`).
- `readRawBlob(id)` keeps its shell-side `z.string().min(1).parse(id)` (step 3), whoever fills
  the member (E5.3).
- `workload()` (R): `activeSessions` counts actors with `session_attached`. `engine.frames` and
  `engine.frameBytes` sum `backlog`, and `engine.queuedSends` sums `repo.queued_count` (E5.4;
  until then the call throws `NativeEngineIncomplete("queued sends count lands in E5.4")`).
- `rootAgent(threadId)` (R, may apply a tick): `index.ts:853`–`:861` over `repo.root_agent_id`, and
  `get_or_create` + `apply([{type:"tick"}])` when it is undefined.
- Internal, for `actorContext` and the probe: `actorFrame`, `actorPaused`, `actorWait`. They are
  not `Engine` members, so the facade's member table does not list them.

`activeRun`, `turnOrigin`, `delegationsInFlight`, `aceCaller` and `withinAgent` stay E5.5's.

### 15. The probe (binding `engine/probe_actor.rs`, shell `native-engine/testing.ts`)

```ts
attachSession(threadId: string, spec: {
  translator: Translator;           // any JS translator, e.g. @ace/adapter-testkit's
  stream?: "deltas" | "never";      // the probe repo's answer to stream()
  generation?: number;
}): Promise<ProbeSession>;
interface ProbeSession {
  context: Pick<SessionContext, "onFrame" | "outputFlow">; // built by actorContext, exactly as E5.6 will
  aborted(): number;                // how many times abort_session ran
  retire(): void;                   // retire_generation, as an onExit would
  log(): ProbeActorLog;             // per op: frames, facts, streamed, outermost, committed; wakes; diagnostics
}
```

`attachSession` installs probe deps on `core.actor_deps` the first time it is called. They are a
`ProbeRepo` and `ProbeLinks`, plus E5.2's real `LiveStore`. It then creates the actor through
`get_or_create` and marks `session_attached`. `ProbeRepo` has **no fold**. `apply` writes one
event per call, `{ type: "probe.batch", facts: <n> }`, through `core.store.atomic` and
`Tx::append_events` (the event shape E5.1's probe `write` step uses), and records whether the
transaction was outermost. `stream` returns true when `spec.stream` is `"deltas"` and every fact
is an `item.delta` or `signal`. It then calls `prepare_live_write` and `buffer_live_write` (the
shared buffer of step 16) with one probe event and a snapshot whose `persist` and `committed` only
record. `status` returns a
counter the test can bump, and every other method returns a fixed, recorded answer. `ProbeLinks`
records each call. That is scripting, not thread behaviour, so E5.1's must-not holds. E5.3 deletes
`ProbeRepo`'s `stream` and `apply` when its own repository can stand in.

### 16. The live buffer on the shared stack, flushed by the pump (`frames/live.rs`; store shell `native-writer/live.ts`, `store-stream.ts`)

ADR 0223 §5 (`:300`–`:306`): the Rust engine calls `ace_store` directly on the shared stack, its
streamed deltas included, and "the live buffer's flush is a task on the owning thread, run by the
pump, so it is never inside another transaction". So `LiveStore` is not a port onto a second
buffer. It reaches the connection's **one** live buffer, the one `native-writer/live.ts` drives
behind `ACE_STORE_WRITER=live` (which `transactions` implies, E5.1's prerequisite), the way E5.1
reached the one transaction stack (E5.1 decision 4, correction 8 here):

- **One buffer, one order.** The binding hands the engine a handle to the connection's
  `NativeLiveBuffer`, the same instance the shell uses. `buffer_live_write` appends the engine's
  events to it in the order the engine produced them, interleaved with any TypeScript appends in
  call order. The shell keeps its entry list, and a Rust-sourced entry holds a token for its
  snapshot: at the flush, the shell calls `persist(token)` and `committed(token)` back as
  synchronous engine entries (E5.3's `persist` and `committed`, `repository.ts:396`–`:409`). The
  events are encoded once, by Rust, with `ace_json`, and are never rebuilt as JavaScript objects
  except where the shell's publication already builds them.
- **The pumped flush.** With a native engine attached, the shell's deadline timer (`live.ts`, the
  75 ms and 1 s deadlines the buffer returns, and the retry delay a failed attempt arms) does not
  run its attempt inline. It calls the engine's `flush_due()`, a synchronous entry that spawns
  one flush task on `Lane::Work`, deferred through `defer` (it starts work), and coalesces when one
  is already queued. The task runs from the pump, so no other transaction is open (E5.1 step 2's
  `Busy` check), and the flush's own transaction is a top-level one on the shared stack. **The task
  calls the scheduled-attempt path, `StoreStream.scheduled()` (`store-stream.ts:233`–`:244`),
  exposed to the hook as `runScheduled()`. It never calls the public `flush()` (`:221`).** The
  difference matters on retry: while a failed batch is pinned, `flush()` throws `waiting()` without
  attempting (`:223`), so a retry routed through it would never run, and the batch would stay
  pinned with every writer waiting on it. `scheduled()` rearms when writes are held, attempts
  otherwise (`attempt()` retries a recovering batch, or isolates and quarantines after
  `quarantineAfter` strikes), and swallows the attempt's error after the attempt has reported it
  and armed the next retry. The flush task therefore never fails. Seam test 18 proves it. The flushes the store makes
  itself are unchanged: before a transaction begins (`store.ts`'s `transactionHost().flush`),
  when the buffer is full, and on `flushLiveWrites()`. With no engine attached (the switch off),
  no hook is set and the timer flushes inline as today, byte for byte. That is one optional hook
  in `store-stream.ts`, set and cleared by `liveStorePort`.
- **The writable predicate, shared** (owner decision 3). `Store.writableNow()` is the
  exact condition `writable()` returns on: not held, not writing history, and no failed live
  batch (`store.ts:855`–`:884`). `writable()` is rewritten to loop on it, so there is one
  predicate, not two copies. `Store.write`'s own re-check (`:888`) is unchanged.
  `LiveStore::writable_now` calls it.
- `history_writing`, `live_write_blocked`, `writable` and `prepare_live_write` go through the
  shell's public methods. `liveStorePort` subscribes to `onLiveWriteQuarantine` and calls
  `actor::quarantine`.
- **Files and review.** `native-writer/live.ts`, `store-stream.ts` and `store.ts` (the hook,
  `writableNow`, and the buffer handle on the binding's connection) are the store's, and a store
  reviewer signs off that commit. The switch-off proof is the store's Task 5.4 list with
  `ACE_STORE_WRITER=fold,sequences,events,columns,live,transactions`, each file alone and
  unchanged, plus `live-write-buffer.process` and `signal-batching.process` with the engine off.
- **Order of landing.** Everything else in E5.2 (the moved cases, the frame helpers, the actor and
  the seam tests except those marked "step 16") does not depend on this step and lands first.
  This step lands before E5.3's `stream` is wired, and E5.6's proof needs it.

## Re-entrancy (in addition to E5.1's nine rules)

10. A translator, an `ActorRepo` or `ActorLinks` method, or a `LiveStore` call may call back into
    the engine synchronously (a JavaScript translator can call a facade read). None of them runs
    inside `with_state`, and the actor's own bookkeeping is re-read after each of them.
11. `actorFrame` can be called from inside an op, if a port the op called makes the session emit
    a frame synchronously, or from inside any open transaction. It only appends to `pending` and
    may seal. A sealed frame batch is work of the first kind (step 7): it is queued behind the
    running op at once and wakes the mailbox directly, and a rollback of the enclosing transaction
    does not discard it. Nothing runs inline. A generic `enqueue` made in the same place is staged
    and deferred instead (step 7).
12. The live flush runs as a pump task (step 16). The shell calls E5.3's snapshot back in a fixed
    order (`store-stream.ts:296`–`:335`): **`persist` runs inside the flush's transaction**, before
    it commits, so the thread's header and records commit with the batch's rows (and roll back
    with them); **`committed` runs after the outermost commit**, from the transaction's
    `committed` outcome, **before** the buffer retires the batch. That is the real order on both
    backends: the outcome calls `buffer.committed(threads, rows)` (`store-stream.ts:328`–`:332`),
    which calls each thread's `snapshot.committed()` first and only then removes the batch and
    settles (TypeScript `live-write-buffer.ts:165`–`:167`, native `native-writer/live.ts:196`–`:199`),
    and publication (`store-stream.ts:333`) comes after both. The Rust snapshot keeps that order
    and the code does not change. `committed` must not assume the batch is already gone from the
    buffer, and it can rely on its rows being durable. It never runs on a savepoint's
    release or after a rollback, which only rearms (`rolledBack`). Both are synchronous entries
    and never run a task. A flush the store starts itself (before a transaction begins) keeps the
    same order inside that call. A retried batch calls `persist` again only for the threads
    `:324` names.
13. No borrow of `ActorDeps.translators` is held across a translator call (step 7).
14. Direct wakes only for work that does not depend on the enclosing transaction. Receipt-dependent
    `enqueue`s and new actors' tasks go through `defer` and are discarded on rollback (step 7).

## Proof

**What E5.2 can prove alone, natively.** No (a) file. `signal-batching`, `sdk-burst` and
`streaming-behaviour` open real sessions through scripted adapters, and so does every
storage-row file (`live-write-buffer`, `live-write-quarantine`, `storage-behaviour`,
`resource-limits`, …). The first to go green is at E5.6, with E5.3 and E5.4 landed. Until then
each fails with `NativeEngineIncomplete` naming E5.3, E5.4 or E5.6, and that is the expected
result. Amend E5.1 step 12's table so E5.2's row reads: seam (acknowledgement on the outermost
commit and on live-buffer acceptance, never on flush; batch bounds; timer-boundary sealing;
pause at 256 and resume at 64; overflow; poisoning; envelope and byte failures; native frames)
and Rust (the (b) cases, `stream_facts` order, attachments). Still blocked: the three named files
and the storage row, by E5.3, E5.4 and E5.6.

| Suite (each alone)                                                                   | Switch on, after E5.2        | First green                        |
| ------------------------------------------------------------------------------------ | ---------------------------- | ---------------------------------- |
| `native-engine/actor.test.ts` (seam tests)                                           | green                        | E5.2                               |
| `cargo test -p ace-engine` (`frames::*`, `actor::*`)                                 | green                        | E5.2                               |
| `engine/actor-timer.test.ts`, `frame-envelope.test.ts`, `fact-bytes.test.ts`         | unchanged, switch off and on | (cases moved)                      |
| `engine/signal-batching.process`, `sdk-burst.process`, `streaming-behaviour.process` | fails naming E5.3/E5.6       | E5.6                               |
| storage row (`live-write-buffer`, `live-write-quarantine`, `storage-behaviour`, …)   | fails naming E5.3/E5.6       | E5.6, `startup-quarantine` at E5.8 |
| `engine/attachment-echo.process` (an E1 file too)                                    | fails naming E5.5/E5.6       | E5.6                               |
| `engine/reliability.process`                                                         | fails naming E5.6            | E5.6–E5.8                          |

**Order of landing.** The moved (b) cases, the frame helpers, the actor and every seam test not
marked "step 16" land first; step 16 and its seam test follow. E5.6's proof also needs E5.3's
`released_thread` (moved forward from E5.10) and the empty-journal skip of `cursor_record`, so a
thread that is not Cursor's never reaches E5.8.

**Switch off, byte-identical**: each alone, unchanged and passing: `engine/actor-timer.test.ts`,
`frame-envelope.test.ts`, `fact-bytes.test.ts`, `signal-batching.process.test.ts`,
`sdk-burst.process.test.ts`, `streaming-behaviour.process.test.ts`,
`live-write-buffer.process.test.ts`, `storage-behaviour.process.test.ts`,
`attachment-echo.process.test.ts`, and E5.1's `native-engine/skeleton.test.ts` with the switch on
(the corrections must not break it).

```sh
(cd native/daemon && PATH=$HOME/.rustup/toolchains/1.95.0-aarch64-apple-darwin/bin:$PATH \
  CARGO_BUILD_JOBS=4 cargo test -p ace-engine && \
  PATH=$HOME/.rustup/toolchains/1.95.0-aarch64-apple-darwin/bin:$PATH \
  CARGO_BUILD_JOBS=4 cargo build --release -p ace-daemon-node --features engine-probe)
for f in apps/daemon/src/native-engine/actor.test.ts apps/daemon/src/native-engine/skeleton.test.ts; do
  e=$(mktemp)
  test -f "$f" && ACE_STORE=native ACE_STORE_WRITER=fold,sequences,events,columns,live,transactions \
    ACE_ENGINE=native ACE_ENGINE_EVIDENCE="$e" bun --bun x vitest run "$f" --maxWorkers=4 && test -s "$e"
done
for f in actor-timer.test.ts frame-envelope.test.ts fact-bytes.test.ts signal-batching.process.test.ts \
  sdk-burst.process.test.ts streaming-behaviour.process.test.ts; do
  p=apps/daemon/src/engine/$f
  test -f "$p" && bun --bun x vitest run "$p" --maxWorkers=4
done
```

## Tests to write

Moved (b) cases, rule 4: `actor-timer.test.ts`'s 6 rows to `actor/timer.rs`, and the
`frame-envelope` and `fact-bytes` rows to `frames/envelope.rs` and `frames/bytes.rs`, as steps 1
and 2 say.

New Rust tests (behaviour nothing covers directly today; the commit says so):

- `frames/bytes.rs`: "`utf8_len` counts a lone surrogate as three bytes, as Buffer.byteLength does".
- `frames/coalesce.rs`: "adjacent deltas merge up to 4096 bytes and keep the previous fact's key
  order"; "a signal between two mergeable deltas is dropped only when it is the deltas' own agent's,
  and any other boundary is kept" (rows: same agent, other agent, no agent); "a lone-surrogate
  append counts three bytes toward the bound".
- `frames/attachments.rs`: "an echo with no thread-owned upload is returned untouched"; "a matched
  part is removed and the attachment appended in first-match order"; "a base64 value without
  padding hashes as Node decodes it"; "a deeply nested raw field is walked without recursion"
  (depth 100,000); "a raw payload echoing two uploads lists them in the TypeScript's visiting
  order, last sibling first" (two sibling `path` fields; visiting forward makes it fail).
- `frames/correlations.rs`: "remember writes each attachment in schema order without unknown
  keys, whatever order it was given in".
- `actor/intake.rs` (Rust, through the probe actor): "a native frame over 1 MiB, over 32,768
  nodes, or not JSON is skipped with the bridge's warning and leaves the actor untouched", and
  "the native flow mirror pauses once and resumes when the wait resolves, per frame".
- `frames/correlations.rs` over a temp `ace-store`: "a stored attachment comes back in schema key
  order without unknown keys"; "opening twice leaves `sqlite_master` with the TypeScript's DDL text".
- `frames/stream.rs`: "the snapshot is prepared and finished around every fact, a rejected one
  included".
- `actor/flow.rs`, a table: "intake pauses at 256 frames or a quarter of the bytes and resumes only
  at 64 frames and a sixteenth", over `(queued, pending, bytes, limits)` with the hysteresis rows.

Seam tests, `apps/daemon/src/native-engine/actor.test.ts`, `describe.runIf(engineBackend() === "native")`.
Each names in a comment the (a) test that will show it, and is deleted when that file passes with
the switch on:

1. "a batch's frames are acknowledged after its commit, never before": three frames; the promises
   are pending before the batch timer fires; after `batchClock.advance(1)` and a flush, the store
   holds the one probe event, the log shows `outermost: true`, and all three promises resolved in
   arrival order. (`signal-batching` `:160`)
2. (step 16) "established deltas are acknowledged when the live buffer accepts them, before it flushes":
   `stream: "deltas"`; the promise resolves while `store.hasLiveWrite(thread)` is still true;
   after the buffer's deadline the flush ran as a pump task (no transaction open at its start) and
   the probe snapshot recorded `persist` then `committed`. (`signal-batching` `:114`, `:186`)
3. "a batch seals at 256 frames or 256 KiB without waiting for its timer": 256 small frames, then
   two frames of 130 KiB; the batch clock is never advanced, and the log shows batches of 256 and 2.
4. "a frame that arrives after the batch timer fired joins the next batch": fire the timer, then
   call `onFrame` before any pump; the log shows two batches. Sealing in the pump makes it fail.
   - 4b. "a batch whose timer fires with no later frame, flush or tick is still committed and
     acknowledged": one frame, then only `batchClock.advance(1)` and macrotasks (never `flush`,
     never another frame). The promise resolves and the probe event is stored. A mailbox task that
     only uses `try_recv` never wakes, and the test times out.
   - 4c. "an actor tick that fires on an idle actor runs": arm the actor timer through a translator
     deadline, then only advance the `ManualClock` and let macrotasks run. The tick op ran and
     applied `[…translator.tick(now), {type: "tick"}]`.
5. "intake pauses at 256 queued frames and resumes at 64": `limits.maxQueuedFrames: 1024`, the store
   held for writes so no op can run, and frames each sealed by advancing the batch clock.
   `outputFlow.paused()` is false at 255 and true at 256. Releasing the hold drains, and `wait()`
   resolves only once 64 or fewer remain.
6. "a full mailbox commits the accepted prefix, then ends the session visibly": `maxQueuedFrames: 8`;
   the ninth frame's promise rejects with `Provider mailbox capacity exceeded`, the first eight
   are committed, `aborted()` is 1, and the apply log ends with the three overflow facts.
7. "a malformed envelope fails the actor and the frame's promise resolves after the flush":
   `seq: -1`; `onError` got `Provider frame envelope is malformed: seq`, and the next frame
   rejects with `Provider frame failed to commit`.
8. "an SDK frame without its certificate and an oversized frame fail the actor visibly", two cases.
9. "a busy store retries the batch every 100 ms and translates it once": `ProbeRepo.apply` throws a
   busy error twice. The `ManualClock` advanced 100 ms twice commits the batch, and the
   translator's `translate` ran once per frame.
10. "a frame of a retired generation is acknowledged and dropped": `retire()`, then a frame of the
    old generation resolves at once, and no op ran.
11. "acknowledgements never resolve inside a transaction": the probe runs an op with a
    transaction open, through a probe-only hook. The op fails visibly with `NotOutermost`, and its
    promise rejects.
12. "native frames batch and acknowledge as TypeScript ones do": a Rust test in
    `engine/probe_actor.rs` (feature `engine-probe`) feeding `FrameRef::Native` frames through the
    same probe actor; batches and acknowledgements match case 1.
13. "a batch's acknowledgement continuation runs before an exit queued behind it retires the
    generation": a batch, then (before any pump) an `enqueue` that retires the generation, as
    `onExit` does. The promise's `.then` records `generation === current`, and it records `true`.
    It reads `false` if the turn does not end at the acknowledgement. (`engine/sessions.ts:685`–`:711`)
14. "a session replaced during translation keeps the new translator": the JavaScript translator's
    `translate` calls the probe to attach a new session to the same thread. Afterwards the actor
    translates with the new translator, the old one is not put back, and nothing reports
    `Reentrant`.
15. "a frame batch sealed inside a rolled-back transaction is still folded and acknowledged":
    `onFrame` and a flush-triggered seal inside a `store.atomic` that throws. Afterwards the batch
    is committed and its promise resolves (step 7, first kind).
16. "an enqueue made inside a rolled-back transaction never runs, and one inside a committed
    transaction runs in its call order": two `store.atomic`s, each with a frame and then an
    `enqueue`, the first throwing. Only the second op runs, after the frames sealed before it, and
    `backlog()` returns to zero. A direct wake for `enqueue` makes the first op run, and the test
    fails.
17. "an actor created inside a rolled-back transaction is discarded and never polled":
    `rootAgent` (which creates the actor and applies a tick) inside a `store.atomic` that throws.
    Afterwards `liveThreadIds()` lacks the thread, `probe.turns()` shows no poll of its task, and
    no waker is registered for it. The same call inside a committed transaction leaves the actor
    live with its tick applied.
    17b. "an actor created at capacity inside a transaction returns what TypeScript returns, and
    a rollback evicts nobody": `limits.maxActiveThreads: 2`, two committed actors with no
    `engine_slots` row. (i) `rootAgent` for a third thread inside a `store.atomic` that throws:
    the call succeeds as in TypeScript, and afterwards both original actors are live and
    untouched, and `liveThreadIds()` is unchanged. (ii) The same call inside a committed
    transaction: after commit, the oldest is evicted (the one TypeScript evicts at the call), and
    the new actor and the other original are live. (iii) Inside one transaction, two creations
    with room for one pledge two different victims and hold two reservations; a third creation
    throws `Engine actor capacity exceeded` at the call, as TypeScript does when every remaining
    actor holds a slot. Evicting at the call fails (i); promoting without a held reservation fails
    (iii).
    17d. "a reservation lost at promotion never acknowledges as success": the probe invalidates a
    provisional actor's reservation before its first poll. A frame queued on it rejects with
    `Provider frame failed to commit`, an op staged on it is reported with
    `Engine actor capacity reservation lost for <thread>`, `links.wake(thread)` was called, and no
    promise resolved `Done`.
    17c. "staged enqueues of a rolled-back transaction never overflow the mailbox":
    `limits.maxQueuedFrames: 4`, three frames sealed and held behind a write hold, then five
    `enqueue`s inside a `store.atomic` that throws. There is no overflow: `aborted()` is 0, no
    overflow facts are applied, `outputFlow.paused()` is unchanged, and the three frames commit and
    acknowledge once the hold is released. The same five inside a committed transaction overflow at
    admission: the accepted prefix commits, then the three overflow facts, as TypeScript's
    `acceptOperation` does. Counting staged slots at the call makes the rollback case fail.
18. (step 16) "a live batch whose first attempt fails is retried as a pump task and stored": the
    probe snapshot's `persist` throws a busy error once. The retry timer fires and the task runs
    `runScheduled` (not `flush()`), which stores the batch. `persist` ran inside the retry's
    transaction and `committed` after its commit, in that order, and a writer waiting on
    `writable()` proceeds. Routing the retry through `flush()` leaves the batch pinned, and the
    test times out.

## Benches

- **Signal batching.** There is no separate bench file. `bench/live-write-buffer.ts` drives
  deltas through a real engine and the live buffer, and reports transactions and delivered
  deltas. Record its switch-off figures in the PR now. With the switch on it needs a session
  (E5.6), which then reports both. Report also the switch-off count from `signal-batching`'s first
  test (0 transactions for 20 signals, ≤ 3 after the tool frame), which E5.6 must match exactly.
- **Head-of-line.** `bench/head-of-line.ts --runs=3` needs sends (E5.5, E5.6). E5.1 recorded the
  switch-off baseline. E5.2 adds nothing to it and runs it after E5.6, against E5.1's baseline,
  under the `live` bulk: `stopAck` and `sendReceipt` p50, p99 and max, plus the event-loop delay.
  The figures E5.2's design can move are the mailbox's per-op yield and the turn it ends at each
  JavaScript acknowledgement (step 9), so report the binding's longest poll, its count of polls
  over 16 ms, and the turns per second under `live`, beside `stopAck`.
- **The actor's own cost, now: sparse and full batches** (owner decision 6). The shared
  promise saves deferreds, but the binding still reads every frame's envelope fields, and the
  shell encodes and Rust parses the facts. So measure both shapes, end to end, switch off and on,
  through the same scripted translator: **sparse** batches (one frame per batch, the batch clock
  advanced after each) and **full** batches (256 frames per batch). For each, report the
  per-frame cost of `onFrame` (shell measure, binding field reads, the call), of translation (the
  JavaScript batch helper, its `JSON.stringify`, and `ace_json::parse` in Rust), and of the
  acknowledgement (one deferred per batch, plus the turn ended at it, decision 5). Report wall
  time per 10,000 frames with p50 and p99 per batch, and the macrotasks per batch. Switch off is
  the TypeScript actor driven the same way through `engine/test-support.ts`'s harness. Run it as
  one timed case in `native-engine/actor.test.ts` that prints and asserts nothing about speed, or
  as `bench/live-write-buffer.ts` with `--sparse` and `--full` flags if that bench can host it
  without a session. No new bench file.

## Files (all yours; nothing else except the E5.1 corrections)

- `native/daemon/crates/ace-engine/src/actor/{mod,state,deps,intake,native,mailbox,fold,failure,flow,timer,leases,rules}.rs`
  (replacing `actor.rs`) and `frames/{mod,bytes,envelope,coalesce,raw,attachments,attachment_payload,correlations,stream,live}.rs`
  (replacing `frames.rs`).
- `ace-engine/Cargo.toml`: `indexmap` (the TypeScript `Map` order, rule 8), `sha2` and `base64`
  (image hashes), the versions already in `native/daemon/Cargo.lock`, each with a comment saying
  why.
- `native/daemon/crates/ace-daemon-node/src/engine/{actor,frames,js_translator,probe_actor}.rs`.
- `apps/daemon/src/native-engine/{actor,frames}.ts` and `actor.test.ts`.
- E5.2's seams in E5.1's files (corrections 6–9), and nothing else in E5.1's files.
- The store's files of step 16 (`native-writer/live.ts`, `store-stream.ts`, `store.ts`), with a
  store reviewer on that commit.
- Every file under 400 lines; none over 1,500 (`bun run check:size`).

## Must not

- Resolve an acknowledgement on a live-buffer flush, on a savepoint's release, or before its op's
  last commit, or reject one that committed.
- Seal a batch in the pump when a sync entry could have sealed it at the firing (decision 3).
- Translate a batch twice, or write a Cursor record only once across retries.
- Hold a `with_state` borrow across a translator, trait method, port or await.
- Run two ops of one actor in one poll, or run an op while a transaction is open.
- Give the probe a fold, or make an unported trait method succeed silently.
- Use `serde_json`, `str::len` on JavaScript strings, or `HashMap` where TypeScript iterates a `Map`.
- Change `engine/*.ts`, the store's formats, `engineSchemaVersion` 9, or the DDL text.
- Poll a timer receiver only with `try_recv`, keep a borrow of the translator map across a
  translator call, or flush the live buffer from a timer callback while a native engine is attached.
- Patch E5.1's corrections 1–5 in E5.2's branch.
- Run the full suite, `bun run check`, `test:process` or any tier; one file at a time (rule 3).

## Reviewer checks

- Each message string matches the TypeScript byte for byte (step 8, step 11).
- The pause and resume thresholds and the five seal conditions match `actor.ts:92`–`:113` and
  `:341`–`:348`.
- Acknowledgement rows: committed batch after its last commit, streamed batch on acceptance,
  refused batch rejects after the ops before it, poisoned or overflowed at settle time rejects.
  Moving the settle to after `flush_live_writes` makes seam case 2 fail.
- `catch_up` runs at the top of every sync entry and every mailbox poll, and the parked task has
  polled both receivers. Replacing the poll with `try_recv` makes seam tests 4b and 4c fail.
- An op that settled a JavaScript acknowledgement ends the turn (seam test 13).
- The translator is taken out and put back only if its session is still current (seam test 14).
- The live buffer is the connection's one buffer, and with the engine attached its deadline and
  retry attempts run as a pump task through `runScheduled`, never through `flush()`. With the
  engine off the store's files behave exactly as before.
- Snapshot order: `persist` inside the flush's transaction, `committed` after the outermost commit
  and before the buffer retires the batch, then publication (`store-stream.ts:328`–`:333`).
- Rollback scope: frame batches and ticks wake directly; receipt-dependent `enqueue`s are staged
  and deferred; an actor created in a rolled-back transaction is discarded and never polled (seam
  tests 15–17).
- Rollback capacity: a provisional actor holds its slot from the call, and its victims are pledged,
  not evicted; commit evicts and promotes (promotion cannot fail), rollback releases. Staged slots
  count only at admission, on committed state. Outside a transaction eviction and overflow are
  TypeScript's. No path resolves an acknowledgement `Done` for frames it did not fold, except the
  stopped-actor and stale-generation drops TypeScript also acknowledges (`actor.ts:304`) (seam
  tests 17b–17d).
- `released_thread` is E5.3's, `cursor_record` is called only for a non-empty journal, and
  `latest_generation`'s row says E5.4 reads both indexed maxima.
- The coalescer checks the in-between signal's own agent, and the raw walk visits siblings last
  first.
- The native path enforces `ProviderPayload`'s limits with the bridge's warning, and mirrors flow
  per frame.
- Merges and spreads replace keys in place, and `Correlations::get` returns schema order.
- `json_string_bytes`, `utf8_len` and `streamed_facts_bytes` work in UTF-16 units.
- `deps.rs`'s `Unported` methods each name the right owner; no owner's method has a body in E5.2.
- With the switch off, `git diff origin/ace/daemon-rust-rewrite -- apps/daemon/src/engine` is empty.

## Owner decisions (2026-11-24, after review by gpt-6.2-sol)

1. **Owner-tagged traits and the live-store port stay**, with the live store on the shared stack
   and its flush run by the pump (step 16). Each later owner replaces only its methods' bodies in
   `deps.rs`.
2. **Continuation order is kept**: a JavaScript acknowledgement ends the pump turn (decision 5,
   correction 9).
3. **One writable predicate**, `Store.writableNow()`, shared by `writable()`, and re-checked after
   the wait in the turn that runs the op (step 9, step 16).
4. **`latest_generation` is E5.4's**, safe once E5.4 makes sure the ledger table and index exist
   on a fresh home: the indexed maximum of both sources on the same connection, with the legacy
   backfill's `NULL`s ignored (step 6).
5. **Corrupt-row error text may differ** (a malformed stored attachment). The callable empty-id
   error of `readRawBlob` stays exactly today's (step 3).
6. **One promise per batch**, measured on sparse and full batches with encoding and parsing
   included (Benches).
7. **E5.1's flush, `flush_depth`, waker and wake-log gaps are fixed in E5.1's open review**
   (corrections 1–5). E5.2 relies on them and does not patch them.
