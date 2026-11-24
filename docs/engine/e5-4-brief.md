# E5.4: commands, intents, queue and inputs in Rust (switch `ACE_ENGINE=native`)

Part of the [engine porting guide](porting-guide.md). Its rules 1–16, "Files per work item" and
"For every E5 item" apply unchanged, and so does the [E5.1 brief](e5-1-brief.md): its decisions,
its facade kinds (R, M, A, H, B), its re-entrancy rules and its test seam (step 12). Where this
brief is more exact, it wins. Read
[ADR 0223](../adr/0223-the-engine-and-adapters-move-to-rust-behind-the-same-interfaces.md) §4, §5
and §8, [ADR 0053](../adr/0053-queue-and-recovery.md) (the queue, holds and recovery, with its
amendments of 2026-10-15, -17 and -18), and [behaviour.md](behaviour.md) §3, §9, §10 and §17
first. TypeScript paths are in `apps/daemon/src/engine/` unless they say otherwise; line numbers
are as of `origin/ace/daemon-rust-rewrite` a9229d6400.

E5.4 ports what happens between a command arriving and its work being picked up: the receipt
(`handler.handle`, synchronous inside the receipt transaction), creation admission and
validation, the durable intents and the queue, the input journal and the transcript's input
items, ace's own inputs, and the sends worker's choice of what to deliver next. It does not
deliver anything: claiming an intent and calling the provider is E5.5, opening sessions is E5.6.

It is the largest E5 item, so it lands as six builder rounds, **E5.4a to E5.4f**, each under
about 2,000 lines of Rust (tests included), each behind the one switch, each leaving the switch-off
path byte-identical.

## Decisions this brief makes

1. **Six sub-items in dependency order** (table below). E5.4a and E5.4b touch only their own
   tables and pure rules, so they run in parallel with E5.2 and E5.3. E5.4c to E5.4e need E5.3's
   `Repo` (thread state, `apply`, `save`, the store reads) and start once E5.3 has merged. E5.4f
   needs E5.2's actor and E5.4e. E5.5 starts after E5.4f, as the guide orders it.
2. **The receipt path is ported whole, wherever its code lives.** A receipt that reaches an
   unported function fails, and the failure makes the whole receipt roll back. If E5.4 ported only
   its own files, nearly every native receipt would fail until E5.10, because a create calls
   `permissions.ensure` (E5.7) and `transitions.set` (E5.9), and a Stop calls `cancelPending`
   (E5.10). So E5.4 also ports the **synchronous, receipt-time** functions of later items' modules
   that every ordinary receipt reaches. It writes them in those owners' files, which is safe
   because E5.5 to E5.10 start after E5.4f. The owner then keeps them as its own code, and its row
   in the guide drops them. Branches that only special receipts reach (fork, switch, merge,
   permission changes, interaction answers, imported threads) become declaration stubs in the
   owner's file. They fail `NotPorted` naming the owner, and the receipt rolls back. "The receipt
   path" below lists every function and which way it goes. This is open question 1; until the
   owner answers, build it this way.
3. **Never edit E5.2's or E5.3's files.** They are built in parallel. What E5.4 needs from E5.3
   (`Repo`) it calls through E5.3's API ("Seams", below), and what E5.2 needs from E5.4 (the
   input journal's correlation on the frame path) E5.4b provides as `pub fn`s named here.
4. **`Recovery`'s command path is E5.4's.** `recovery.ts` is E5.8's module, but the receipt calls
   `recovery.handle` (every queue command), `recovery.admit`, `sync` and `releaseLimitHold` on every
   send. E5.4d takes those methods (listed in the module map) into `ace-engine/src/queue/holds.rs`.
   E5.8 keeps the rest of `recovery.ts` (restart captures, limit observation, deadline firing) and
   calls `holds` for the shared parts. This is open question 2.
5. **Daemon services stay TypeScript, reached through synchronous ports.** `workspaceDirectory`
   (`realpathSync`), the handoff text (`portableContext` over `@ace/handoff`) and the forge links
   of a created thread (`WorkspacePrLinks`, `WorkspaceIssueLinks`) are not engine logic, and a
   Rust copy would not be byte-identical: `std::fs::canonicalize` returns the on-disk case on
   macOS and a `\\?\` prefix on Windows, where `realpathSync` does neither. That is the precedent
   `worktree-title.ts` set (it stays TypeScript behind the `worktreeGit` port). E5.4e adds three
   synchronous ports to `ports.rs` in one commit (open question 5).
6. **Pure package helpers on the hot or receipt path move to Rust.** These are the input
   signature on every echoed frame, the provisional title on every person send, and the provider
   admission rule on every command. Each goes into the crate that owns it (open question 6). Its
   TypeScript stays, because the web app, iOS and the TypeScript adapters keep using it. No case
   is copied into Rust: the (a) files that reach a helper prove it, and a helper that no (a) file
   reaches gets one cargo test, and the commit says which (rule 5).
7. **`personCommand` stays in the shell.** E5.1 step 9 keeps the normalization in
   `native-engine/engine.ts` (`handler.handle` calls `personCommand` before the binding). So
   `person-command.ts` is not replaced, and `admitCreation`'s facade calls it before the binding
   too. The guide's E5.4 row is corrected to say so.
8. **`message-facts.ts` splits.** `readyForInput` and `threadCapabilities` are the sends worker's,
   and E5.4f ports them. `readMessageFacts` serves the facade's `messageFacts` member, which E5.1
   gave to E5.5, and it reads E5.5's `steer-yield` rules. So it moves to E5.5 (open question 3).
9. **Open-time statements stay as they are.** The constructors of `QueueStore`, `IntentStore`,
   `InputJournal`, `AceInputs` and `indexTitleInputs` run DDL, a forward migration and two
   history-sized statements at every open (`queue-store.ts:57`–`:94`, `intents.ts:56`–`:65`,
   `input-journal.ts:69`–`:104`, `ace-inputs.ts:9`–`:17`, `title-input.ts:9`–`:15`). The engine's
   stored formats do not change in ADR 0223 (§5), so the native open runs the same statements in
   the same order. E5.4 exposes them as `queue::open`, `intents::open` and `inputs::open`, and
   E5.3's repository open calls them where `repository.ts` constructs those classes today. The two
   that break ADR 0170 are noted in open question 7 and are not fixed here.

## The sub-items

| Sub-item                                         | What it ports                                                                                                                                                                                                                     | Rust (`ace-engine/src/`)                                                                                                             | Needs              | Facade members it fills                                                                          | Est. Rust lines |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------ | --------------- |
| **E5.4a** intents and the queue store            | `intents.ts`, `queue-store.ts`, `snooze-wake.ts` (`wakeFor`), `input-fate.ts`, `input-delivery.ts`, `edited-context.ts`, `goal-change.ts`; the repository's intent and queue delegations; `boundedJson`                           | `intents/{mod,header,store}.rs`, `queue/{mod,record,store,page,wake}.rs`, `inputs/fate.rs`, `rules.rs`                               | E5.1               | `queue`, `queuePage`, `commandFailure`, `commandExecution`, `prioritizeSubagentResult`           | 1,700           |
| **E5.4b** the input journal and input text       | `input-journal.ts`, `ace-input-attribution.ts`, `ace-waits.ts`; the input-text helpers it uses (`withoutPortableHandoff`, `withoutHandoffEnvelope`, `nativeCommandInputs`, Claude's and Pi's provider input, `aceWaitTargets`)    | `inputs/{journal,origin,signature,ace_waits}.rs`; `ace-adapter-claude/src/input.rs`, `ace-adapter-pi/src/input.rs` (the parts named) | E5.1               | none (E5.2's frame path calls it)                                                                | 1,500           |
| **E5.4c** transcript inputs and ace inputs       | `transcript-inputs.ts`, `ace-inputs.ts`, `title-input.ts`, `thread-posts.ts`; `provisionalTitle`                                                                                                                                  | `inputs/{transcript,ace,title,posts}.rs`, `inputs/provisional_title.rs`                                                              | E5.3, E5.4a, E5.4b | `inputFate`                                                                                      | 1,300           |
| **E5.4d** queue commands, holds, receipt prelude | `queue-commands.ts`, `stale-inputs.ts`, `guest-admission.ts`; `Recovery`'s command path; the receipt's prelude (`handler.ts:55`–`:123`); `steer-selection.ts` and `steer-notes.ts` (receipt path)                                 | `queue/{commands,holds,stale}.rs`, `commands/{mod,prelude,guest}.rs`; `steering/{selection,notes}.rs` (owner E5.5)                   | E5.3, E5.4a–c      | `handler`, `internalHandler` (prelude and queue commands), `admissionReopened`, `prepareCommand` | 1,800           |
| **E5.4e** thread receipts and creation           | the rest of `handler.ts`, `create-thread.ts`, `creation-admissions.ts`, `creation-validation.ts`, `workspace-directory.ts` (as a port); receipt-path functions of `stop-intents`, `stop-scope`, `permissions`, `transition-state` | `commands/{receipt,stop,create,admissions,validation}.rs`; owners' files as "The receipt path" lists                                 | E5.3, E5.4d        | `handler` (every command), `spawn`, `admitCreation`, `creationPending`, `cancelDelegatedInputs`  | 1,950           |
| **E5.4f** the sends worker                       | `Engine.work`, `wake`, `wakeQueued`, `releaseDormant` (`index.ts:1220`–`:1384`); `readyForInput`, `threadCapabilities` (`message-facts.ts:42`–`:87`)                                                                              | `queue/{worker,ready}.rs`                                                                                                            | E5.2, E5.4e        | none (internal; the sends lane's `run`, E5.1 step 11)                                            | 700             |

Every sub-item adds its binding methods in its own `#[napi] impl NativeEngine` block in
`ace-daemon-node/src/engine/{intents,queue,inputs,commands}.rs` (E5.1 step 9) and fills the matching
functions in `apps/daemon/src/native-engine/{intents,queue,inputs,commands}.ts`. A sub-item that
would pass 2,000 lines splits along the module list above, never by arbitrary cuts, and no file
passes 400 lines.

## Module map

Each TypeScript module, by line, to its Rust module and sub-item. "Moves" means the owner's row
in the guide drops it; "stub" means a declaration in the owner's file that fails
`EngineError::not_ported(<what>, <item>)`.

### E5.4a

| TypeScript                                                                                                                                                                                                                           | Rust                                           | Notes                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intents.ts:9`–`:50` (`Header`, `columns`, kinds, `header`)                                                                                                                                                                          | `intents/header.rs`                            | `IntentHeader` with the same fields; `status` and `delivery` decode strictly, as zod does. A row this build can't read is reported through `headers`'s `unreadable` callback, never dropped silently.                                                                                                                                             |
| `intents.ts:52`–`:65` (constructor)                                                                                                                                                                                                  | `intents/mod.rs` `open`                        | The four `CREATE INDEX IF NOT EXISTS`, same text, same order (decision 9).                                                                                                                                                                                                                                                                        |
| `intents.ts:74`–`:456` (every method)                                                                                                                                                                                                | `intents/store.rs`                             | Same SQL, character for character, as prepared statements cached per text on the shared connection. `headers` pages by 64 on `id` as today (`:133`–`:160`); `uncertainSends` pages by 64 (`:236`–`:250`).                                                                                                                                         |
| `queue-store.ts:19`–`:50` (`RecoveryRecord`, `exitedAfter`, `exitShown`, `isSend`)                                                                                                                                                   | `queue/record.rs`                              | `RecoveryRecord` is `QueueState` plus the seven fields; `continuation` at most 16,384 UTF-16 units (zod `max` counts code units, not bytes).                                                                                                                                                                                                      |
| `queue-store.ts:52`–`:95` (constructor)                                                                                                                                                                                              | `queue/mod.rs` `open`                          | Tables, indexes, `INSERT OR IGNORE … FROM thread_state`, `requireEngineColumns`, the `exited` forward migration, and the attachment re-track of live inputs, in that order.                                                                                                                                                                       |
| `queue-store.ts:104`–`:240`, `:307`–`:459`                                                                                                                                                                                           | `queue/store.rs`                               | `get` throws `Missing queue metadata`; `set` bumps `revision`, clears `lastFailure` exactly when `:146`–`:150` does, and appends `[...wakeFor, queue.updated]` in one `appendEvents`.                                                                                                                                                             |
| `queue-store.ts:242`–`:306` (`snapshot`, `page`, `message`)                                                                                                                                                                          | `queue/page.rs`                                | `page`'s byte budget is `Buffer.byteLength(String(row.payload))`: UTF-8 bytes of the stored text, cut at 512 KiB after the first message. Its three errors are thrown, not returned (below).                                                                                                                                                      |
| `snooze-wake.ts:6`–`:21`; `@ace/projection` `queueWakesSnooze` (`thread-attention.ts:42`) and `snoozeWokeByQueue` (`snooze-woke.ts:59`)                                                                                              | `queue/wake.rs`                                | Moves from E5.10. Needs `threadAttention` for a queue; port only the queue branch it reads, in `ace-projection` beside `thread.rs`.                                                                                                                                                                                                               |
| `input-fate.ts:1`–`:69`                                                                                                                                                                                                              | `inputs/fate.rs`                               | Pure. The two strings `Removed from queue` and `Cancelled before delivery` are constants here; `stop-intents` and `queue-store` use them.                                                                                                                                                                                                         |
| `input-delivery.ts:5`–`:23`, `goal-change.ts:9`–`:14`, `edited-context.ts:3`–`:21`                                                                                                                                                   | `rules.rs`                                     | `isDeepStrictEqual` on `ExecutionOptions` and `ProviderGoal` is structural equality of the decoded JSON values. `editedContext` compares `JSON.stringify` of both contexts, so key order counts.                                                                                                                                                  |
| `repository.ts:508`–`:515` (`add`), `:586`–`:604` (`engineQueueFact`), `:605`–`:625` (`latestIntent`, `commandsSince`), `:626`–`:642` (`queuedCount`), `:643`–`:660` (`inputCapacity`), `:664` (`mark`), `:485`–`:495` (`cancelled`) | `intents/store.rs`, `queue/store.rs`           | E5.4's, not E5.3's: they are only delegations or SQL over E5.4's tables. `engineQueueFact` reads the thread state, so it is `queue::engine_queue_fact(&ThreadState, …)` and E5.4d calls it with state from `Repo`. `add` passes `interactions.owner` (E5.7), which only interaction answers reach: a stub until E5.7.                             |
| `packages/provider-kit/src/ipc.ts:4` (`boundedJson`)                                                                                                                                                                                 | `ace-json::bounded`                            | Promote `ace-adapter-cursor/src/translate/tool_names.rs:14` into `ace-json`, re-point its caller, and check it against `ipc.ts:4`–`:60`: fail when the UTF-8 bytes exceed the budget, when nodes (values plus own keys, in visit order) exceed 32,768, when depth exceeds 64, or when an array is longer than `32768 - nodes`. One copy, not two. |
| `index.ts:591`–`:597` (`prioritizeSubagentResult`), `:1076`–`:1084` (`commandFailure`, `commandExecution`, `queuePage`), `:1146`–`:1148` (`queue`)                                                                                   | binding `engine/queue.rs`, `engine/intents.rs` | R and M as E5.1's table says.                                                                                                                                                                                                                                                                                                                     |

### E5.4b

| TypeScript                                                                                               | Rust                              | Notes                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `input-journal.ts:23`–`:41` (`inputOrigin`, `personInput`)                                               | `inputs/origin.rs`                | `trigger` `user`/`unknown`/none → `person`; `goal` → `parent_agent`; anything else is its own kind; an explicit `origin` wins and gets `commandId`.                                                                                                    |
| `input-journal.ts:42`–`:66` (`signature`, `providerInput`)                                               | `inputs/signature.rs`             | SHA-256 (`sha2` 0.11, as `ace-adapter-api` already uses it) of the text parts of `withoutPortableHandoff(parts)` joined by `"\n"`, lowercase hex.                                                                                                      |
| `input-journal.ts:67`–`:104` (constructor)                                                               | `inputs/mod.rs` `open`            | Same DDL, in three transactions as today, the two orphan `DELETE`s and the trigger.                                                                                                                                                                    |
| `input-journal.ts:106`–`:294`                                                                            | `inputs/journal.rs`               | `identify` throws `Provider reused an input message identity for a different command`. `generation IS ?` binds NULL for an absent generation, so `IS` (not `=`) is kept.                                                                               |
| `ace-input-attribution.ts`, `ace-inputs.ts:35`–`:41` (`attribute`)                                       | `inputs/ace.rs`                   | `AceInput` decodes `results` at most 64.                                                                                                                                                                                                               |
| `ace-waits.ts`; `packages/mcp-server/src/waits.ts:15`                                                    | `inputs/ace_waits.rs`             | `aceWaitTargets`: decode `WaitArguments` and `DelegateArguments` exactly as their zod schemas in `waits.ts` (including `bareToolName`); a failed decode is `None`. Targets are de-duplicated in first-seen order.                                      |
| `packages/projection/src/portable-input.ts:5`; `packages/handoff/src/envelope.ts:25`                     | `inputs/signature.rs`             | `withoutHandoffEnvelope` measures and slices in **UTF-16 code units** (`text.length`, `indexOf`, `slice`), validates the manifest with `PortableHandoff` from `ace-protocol`, and strips leading `\r?\n` runs.                                         |
| `packages/commands/src/native-command-inputs.ts:3`                                                       | `inputs/signature.rs`             | Throws `Unresolved command mention`.                                                                                                                                                                                                                   |
| `packages/adapter-claude/src/input.ts:30`–`:84` (`content`, text parts only), `:91`–`:99` (`admissions`) | `ace-adapter-claude/src/input.rs` | Only what `providerInput` reads: the first admission's text parts. The errors still fire in the same order (`Unresolved Claude mention`, `Claude image inputs require a matching base64 data URL`), because the journal's `sending` throws them today. |
| `packages/adapter-pi/src/input.ts:4`–`:28` (`piInput(...).message`)                                      | `ace-adapter-pi/src/input.rs`     | Same budget (1 MiB per value, `+256` per part), the same errors and the reserved `/ace-rollback`, `/ace-context` check.                                                                                                                                |

E5.2's frame path calls three functions, and E5.4b exports them with these signatures so that E5.2
can code against them before E5.4b lands:

```rust
pub fn correlate(tx: &Tx, thread: &ThreadId, fact: Fact, root: &str, generation: Option<u32>) -> Result<Option<Fact>, EngineError>; // input-journal.ts:224
pub fn attribute(tx: &Tx, thread: &ThreadId, fact: Fact) -> Result<Fact, EngineError>;             // ace-inputs.ts:35
pub fn ace_wait_fact(state: &ThreadState, fact: &Fact) -> Option<Fact>;                             // ace-waits.ts:10
```

### E5.4c

| TypeScript                                             | Rust                            | Notes                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcript-inputs.ts:14`–`:254`                       | `inputs/transcript.rs`          | Every function, including `admitInput`, `bindStartedRun`, `bindConsumedInput` (E5.5 and E5.2 call them). `bindItemRun` and `bindConsumedInput` mutate the state's item map before returning the event, as today. `notifyNamingPrompt` calls the `onNamingPrompt` port.                                                |
| `ace-inputs.ts:7`–`:33` (`record`, `get`, constructor) | `inputs/ace.rs`, `inputs::open` |                                                                                                                                                                                                                                                                                                                       |
| `title-input.ts`                                       | `inputs/title.rs`               | `oldestTitleInput` walks the index one item at a time through E5.3's `read_item_page`, never a whole page of history.                                                                                                                                                                                                 |
| `thread-posts.ts`                                      | `inputs/posts.rs`               | Reached as `engine.hosts.posts` (`host-threads.ts:42`, `services/thread-address.ts:60`), E5.7's facade object: E5.4c ports the two functions and E5.7 exposes them on `hosts`.                                                                                                                                        |
| `packages/ui-core/src/thread-title.ts:14`, `:53`       | `inputs/provisional_title.rs`   | `provisionalTitle` and `untitledThread` (`New thread`), with `attachmentMarker` (`composer-markers.ts`). The rule is in its doc comment: first line with words, no Markdown, mentions, chips or markers, single spaces, at most 60 characters, cut at a word boundary. Proven by `thread-title.process` `:22`, `:67`. |
| `index.ts:1135`–`:1145` (`inputFate`)                  | binding `engine/inputs.rs`      | One transaction, as today.                                                                                                                                                                                                                                                                                            |

### E5.4d

| TypeScript                                                                                                                                                                                                                                                                                         | Rust                                                      | Notes                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handler.ts:55`–`:123` (guest and host refusals, imported adoption, deleting, retired Cursor, provider disabled, reserved workspace)                                                                                                                                                               | `commands/prelude.rs`                                     | Order is contract (below). `adoptImportedThread` (E5.8) is a stub. `providerCommandDisabled` goes to `ace-core` (`provider_admission.rs`, open question 6).                                                                                                                                               |
| `handler.ts:122` → `recovery.ts:111`–`:129` (`handle`) → `queue-commands.ts:17`–`:262` (`handleQueue`)                                                                                                                                                                                             | `queue/commands.rs`                                       | Every branch. `handle` clears the restart streak on the person's accepted Resume (`:122`–`:127`): `restart-resume.ts`'s `RestartStreaks.clear` is a single `DELETE`, and moves with it.                                                                                                                   |
| `recovery.ts:103`–`:110` (`preferences`), `:91`–`:102` (`prepare`), `:130`–`:165` (`admit`, `withoutRestatedSelection`), `:166`–`:200` (`sync`), `:618`–`:627` (`schedule`, arming only), `:717`–`:739` (`bindingChanged`), `:780`–`:840` (`releaseLimitHold`, `lift`, `owns`, `begin`, `release`) | `queue/holds.rs`                                          | Moves from E5.8 (decision 4). `schedule` arms the deadline timer through the clock port; the timer's callback calls `recovery::fire` (E5.8), a stub that reports `NotPorted` through `onError` once per firing and never throws. `RecoveryPreferences` decodes with its zod defaults (`queue`, `manual`). |
| `stale-inputs.ts`                                                                                                                                                                                                                                                                                  | `queue/stale.rs`                                          | `retire` throws `Invalid intent identity` on a non-integer id. `retireEndedTurnInputs` is called by E5.2's fold path.                                                                                                                                                                                     |
| `guest-admission.ts`                                                                                                                                                                                                                                                                               | `commands/guest.rs`                                       | The (b) cases of `retired-bot-threads.test.ts` move here.                                                                                                                                                                                                                                                 |
| `steer-selection.ts:20`–`:106`, `steer-notes.ts:14`–`:50`                                                                                                                                                                                                                                          | `steering/selection.rs`, `steering/notes.rs` (owner E5.5) | Receipt path (decision 2). `recordSwitch`/`resolveSwitch` (`switch-admission.ts`, E5.9) are stubs, reached only by a steer that changes the model or options.                                                                                                                                             |
| `index.ts:1111`–`:1134` (`prepareCommand`), `:1150`–`:1153` (`admissionReopened`)                                                                                                                                                                                                                  | binding `engine/commands.rs`                              | `silence.prepareCommand` returns at once when no `resolveSilenceMs` port was given (`silence.ts:85`); with one, it is E5.6's stub.                                                                                                                                                                        |
| `index.ts:410`–`:431` (`internalHandler`, `handler`)                                                                                                                                                                                                                                               | shell, as E5.1 step 9                                     | The binding's `handle` is `engineHandler.handle`. With E5.4d alone, every payload type outside the prelude and the queue commands returns `NotPorted("thread commands land in E5.4e")`.                                                                                                                   |

### E5.4e

| TypeScript                                                                                                                     | Rust                                      | Notes                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handler.ts:124`–`:204` (transitions, permission and mode, preparing workspace, size, `fail`, the type list)                   | `commands/receipt.rs`                     |                                                                                                                                                      |
| `handler.ts:205`–`:385` (create and prepare in the receipt)                                                                    | `commands/create.rs`                      | `models.select` (E5.6) is a stub when a `models` port was given; without one the `isDefaultSelection` rule (`@ace/models`) runs in Rust.             |
| `handler.ts:386`–`:479` (archive, thread checks, interaction and task targets)                                                 | `commands/receipt.rs`                     |                                                                                                                                                      |
| `handler.ts:480`–`:556`, `:562`–`:591` (admission tail, Stop, `releaseInterruptedHold`, `stopsOneAgent`)                       | `commands/stop.rs`, `commands/receipt.rs` |                                                                                                                                                      |
| `create-thread.ts`                                                                                                             | `commands/create.rs`                      | `createThreadState` is `ace_core::state::create_thread_state` (`ace-core/src/state.rs:472`).                                                         |
| `creation-admissions.ts`                                                                                                       | `commands/admissions.rs`                  | The owner object becomes a numeric owner id (below).                                                                                                 |
| `creation-validation.ts`                                                                                                       | `commands/validation.rs`                  | `reportedOrTable` (`provider-kit/src/access-modes.ts:127`) and `cursorInstanceId` (`cursor-selection.ts:5`) port beside it, only the paths it reads. |
| `workspace-directory.ts`                                                                                                       | port `workspaceDirectory`                 | Decision 5.                                                                                                                                          |
| `apps/daemon/src/worktree-base.ts:13`–`:53`                                                                                    | `commands/create.rs`                      | `requestedBase`, `requestedBaseKey`, `baseBranchLabel`: pure.                                                                                        |
| `apps/daemon/src/thread-fence.ts:102` (`workChangedSince`)                                                                     | `commands/receipt.rs`                     | SQL over events, same text.                                                                                                                          |
| `index.ts:599`–`:646` (`spawn`), `:1092`–`:1110` (`creationPending`, `admitCreation`), `:921`–`:926` (`cancelDelegatedInputs`) | binding `engine/commands.rs`              | `spawn` still throws `Spawn requires thread.create or thread.prepare`. `permissions.narrow` (E5.7) is a stub, reached only with a `parentThreadId`.  |

### E5.4f

| TypeScript                                                                                   | Rust              | Notes                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts:1300`–`:1384` (`work`)                                                             | `queue/worker.rs` | The sends lane's `run` (E5.1 step 11). Awaits stay where they are: `actor.flush()` first, then every check re-read after it. `delivery.run` (E5.5), `sessions.close` (E5.6), `switchReady` (E5.9) and `steerLane.yielded` (E5.5) are stubs. |
| `index.ts:1256`–`:1277` (`wake`), `:1220` (`wakeQueued`), `:1225`–`:1254` (`releaseDormant`) | `queue/worker.rs` | `wake` checks `isHistoryWriting` and defers through `store.writable()`, as `:1260`–`:1271` does. Reaching `actor.stop`, `repo.evict` and the slot release is E5.2's and E5.3's API.                                                         |
| `message-facts.ts:42`–`:87` (`threadCapabilities`, `readyForInput`)                          | `queue/ready.rs`  | `runsProviderWork` (`transition-history.ts`, E5.9), `repo.quiescent` and `acceptsPersonInput` (`ace-core`, `packages/core/src/person-input.ts:14`, open question 6) are called as their owners provide them.                                |

## The receipt path

Every function an ordinary receipt (create, prepare, send, Stop, archive, every queue command)
reaches, with what E5.4 does with it. "Port" means E5.4 writes it in the named file (decision 2).

| Function (TypeScript)                                                                           | Reached by                                       | Owner | E5.4                                            | Sub-item |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----- | ----------------------------------------------- | -------- |
| `fenceSteer`, `admitSteer`, `queueSteerSelection` (`steer-selection.ts:20`, `:50`, `:96`)       | every send; `queue.edit`                         | E5.5  | port, `steering/selection.rs`                   | d        |
| `steerLostRun` (`steer-selection.ts:36`)                                                        | delivery only                                    | E5.5  | port with the rest of the file                  | d        |
| `SteerNotes` (`steer-notes.ts`)                                                                 | `queue.edit` to steer; queue reads (`fell_back`) | E5.5  | port, `steering/notes.rs`                       | d        |
| `recordSwitch`, `resolveSwitch` (`switch-admission.ts`)                                         | a steer or send that changes model or options    | E5.9  | stub                                            | d        |
| `Recovery` command path (above)                                                                 | every queue command and send                     | E5.8  | port, `queue/holds.rs`                          | d        |
| `RestartStreaks.clear` (`restart-resume.ts`)                                                    | every send; the person's Resume                  | E5.8  | port (one statement)                            | d        |
| `Recovery.fire`, `automatic` (`recovery.ts:579`–`:700`)                                         | a deadline's timer                               | E5.8  | stub (reported, never thrown)                   | d        |
| `wakeFor` (`snooze-wake.ts:6`)                                                                  | every `queue.set`                                | E5.10 | port, `queue/wake.rs`                           | a        |
| `cancelPending`, `cancelDelegatedInputs` (`stop-intents.ts:5`, `:72`)                           | every Stop; delegation cancel                    | E5.10 | port, `liveness/stop_intents.rs`                | e        |
| `targetsRoot` (`stop-scope.ts:10`)                                                              | every interrupt                                  | E5.10 | port                                            | e        |
| `threadTree` (`thread-liveness.ts:13`)                                                          | archive with `beforeSeq`                         | E5.10 | stub                                            | e        |
| `transitions.releaseGuards` (`transition-state.ts:102`)                                         | a Stop with a pending merge or fork intent       | E5.9  | stub                                            | e        |
| `transitions.get`, `set`, `remember`, `guarded`, `guardOwner` (`transition-state.ts:87`–`:196`) | every create; every send                         | E5.9  | port, `transitions/state.rs`                    | e        |
| `transitions.history.grant` (`HandoffAccess`)                                                   | create with `handoffFrom`                        | E5.9  | stub                                            | e        |
| `acceptTransition` (`transition-handler.ts:29`)                                                 | `thread.fork`, `thread.merge`, `thread.switch`   | E5.9  | stub for those three; others pass               | e        |
| `permissions.ensure`, `state`, `read` (`permissions.ts:115`–`:124`)                             | every create                                     | E5.7  | port, `access/storage.rs`                       | e        |
| `permissions.parent`, `narrow`, `accept`, `acceptNative`                                        | spawn with a parent; permission and mode set     | E5.7  | stub                                            | e        |
| `interactions.outcome`, `owner`; `validResolution`                                              | `interaction.resolve`                            | E5.7  | stub for the whole `interaction.resolve` branch | e        |
| `adoptImportedThread` (`imported-thread.ts`)                                                    | a send to an imported thread                     | E5.8  | stub                                            | d        |
| `models.select` (`models.ts`)                                                                   | create with a `models` port                      | E5.6  | stub                                            | e        |
| `repo.reserve` → `reclaimIdleSlot` (`slot-reclaim.ts:24`)                                       | a receipt at capacity                            | E5.6  | stub (only when every slot is taken)            | e        |
| `repo.createSession`, `createUnpreparedSession`, `session`, `backend`                           | every create; capability reads                   | E5.3  | call `Repo`                                     | e        |

A stub's failure inside the receipt is a thrown `EngineError`, so the shell's `store.atomic`
rolls the receipt back and the command gets the JS error. It is never a `CommandResult`. The
switch is off by default until E5.10, so no person sees it.

## The receipt, rule by rule

`engineHandler.handle` (`handler.ts:55`–`:556`) checks in this order. The first that applies wins,
and a refusal commits nothing (behaviour.md §3). The Rust keeps the order exactly, because tests
pin which refusal wins when two apply.

1. **Guest, then host** (`:57`–`:64`), for any payload with a `threadId`: `guestRefusal`, then
   `hostRefusal`.
2. **Imported thread** (`:65`–`:76`): a `thread.send` to an `imported` thread adopts it; if
   adoption throws, `history_unavailable`.
3. **Deleting** (`:77`–`:82`): `thread_deleting`.
4. **Retired Cursor CLI thread** (`:83`–`:95`): a thread with `continuation`, any type but
   `thread.archive` and `thread.fork`.
5. **Provider disabled** (`:97`–`:118`), only when a `providerEnabled` port was given.
6. **Workspace reserved** (`:119`–`:121`): `workspace_change_in_progress`.
7. **Queue commands** (`:122`–`:123`): any `queue.*`, `thread.resume` or `thread.limit` goes to
   `handleQueue` and returns its result.
8. **Transitions** (`:124`–`:134`).
9. **Permission and mode** (`:136`–`:153`): `thread_not_found` without state; else the permission
   result, or `not_implemented` when it declines.
10. **Workspace change preparing or uncertain** (`:154`–`:163`).
11. **Size** (`:164`–`:170`), for `thread.send` and `thread.create` only: more than 64 input parts,
    or `boundedJson(command, 262144)` failing, is `message_too_large`.
12. **Type list** (`:191`–`:204`): anything else is `not_implemented`.
13. **Inside one `store.atomic`** (`:205`): create and prepare (`:206`–`:375`), or the thread
    checks (`:376`–`:445`), or the interaction and task targets (`:446`–`:478`); then the
    admission tail (`:480`–`:553`).

The admission tail, in order:

- Cursor SDK sends: `boundedJson(p.input, maxInputBytes)` → `provider_input_budget_exceeded`;
  `inputCapacity(maxPendingInputs)` → `provider_input_queue_full` (`:480`–`:487`).
- `recovery.admit`: at 256 inputs in flight, or over 256 KiB as `Buffer.byteLength(JSON.stringify(command))`,
  `queue_capacity_exceeded`. It drops a restated selection, then fills an omitted `thread.send`
  delivery from the thread's `followUpBehavior` (`:489`; `recovery.ts:130`–`:165`).
- `fenceSteer`, then `admitSteer` (`:492`–`:494`).
- For `thread.send`: `retireUncertainInputs`, `releaseInterruptedHold`, `releaseLimitHold`, in
  that order (`:500`–`:504`).
- Reserve a slot unless the send is held (`:505`–`:506`): `engine_capacity_exceeded`.
- A thread Stop (`thread.interrupt` whose target is the root, `stopsOneAgent` false): cancel
  pending (`cancelPending`), then set the queue `{paused: true, reason: "stopped", limited: false,
resetAt: null, resumeAt: null, timerAction: null, holdToken: +1}`, then apply `limit.cleared` for
  every limited agent without `externalStatus` (`:510`–`:535`).
- `repo.add`, `acceptInput`, `queueSteerSelection`; for create and send, `notifyNamingPrompt`,
  an empty `queue.set` (a revision bump with its `queue.updated`), `recovery.sync` (`:536`–`:543`).
- The wakes (`:545`–`:548`): the thread, then each released thread. They go on the outermost
  transaction's after-commit queue (E5.1 step 3), never run inline.
- Result: `{commandId, ok: true, threadId}`.

### Error texts, byte-exact

A `CommandResult` crosses as JSON and the shell parses it, so key order is the order below and
fields that are absent stay absent (never `null`). `ok: false` results are `{commandId, ok, error}`
plus, where shown, `code`, `title`, `detail` in that order.

| Error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Extra fields                                                                                                                                             | Source                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `guest_thread`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `title: "No agent here"`, `detail: "This thread holds work from ${guest.name \|\| "another machine"}; it has no agent here."` (an empty name falls back) | `guest-admission.ts:26`–`:32`  |
| `host_thread` (Spade's host thread; types in `startsAgent` plus `thread.fork`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `title: "Spade's own thread"`, `detail: "Spade works through this thread; nothing runs in it."`                                                          | `guest-admission.ts:49`–`:55`  |
| `host_thread` (`spade-bot`, every command)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `title: "A Spade bot's old thread"`, `detail: "Spade bots no longer run here; talk to the bot in Spade."`                                                | `guest-admission.ts:61`–`:67`  |
| `cursor_cli_retired`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `title: "This Cursor thread is read-only"`, `detail: "Continue in a new thread to carry its history to Cursor."`                                         | `handler.ts:89`–`:94`          |
| `interaction_expired`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `code: "interaction_expired"`, `title: "Question expired"`, `detail: "The provider disconnected. This question can no longer be answered."`              | `handler.ts:171`–`:189`        |
| `interaction_unavailable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `code: "interaction_unavailable"`, `title: "Question unavailable"`, `detail: "This question is no longer active."`                                       | same                           |
| `history_unavailable`, `thread_deleting`, `provider_disabled`, `workspace_change_in_progress`, `thread_not_found`, `not_implemented`, `message_too_large`, `thread_creation_in_progress`, `model_unavailable`, `workspace_preparation_mismatch`, `engine_capacity_exceeded`, `thread_changed`, `thread_transition_in_progress`, `unsupported_goal`, `agent_not_found`, `stale_interrupt`, `unsupported_child_control`, `already_resolved`, `invalid_resolution`, `task_not_found`, `task_not_stoppable`, `provider_input_budget_exceeded`, `provider_input_queue_full`, `queue_capacity_exceeded` | none                                                                                                                                                     | `handler.ts`                   |
| `invalid_command`, `pr_requires_worktree`, `thread_exists`, `message_too_large`, `acp_identity_required`, `provider_unavailable`, `workspace_not_found`, `workspace_unavailable`, `workspace_change_in_progress`, `conflicting_account_selection`, `permission_mode_unsupported`, `handoff_source_not_found`, `queue_capacity_exceeded`, `provider_input_budget_exceeded`, `launch_options_unsupported`                                                                                                                                                                                           | none (in `validateCreation`'s order, `creation-validation.ts:23`–`:128`)                                                                                 | `creation-validation.ts`       |
| `invalid_queue_command`, `thread_not_found`, `queue_conflict`, `message_already_claimed`, `uncertain_delivery`, `message_too_large`, `invalid_queue_entry`, `message_not_uncertain`, `engine_capacity_exceeded`, `invalid_queue_position`, `sdk_account_migration_unsupported`, `acp_account_fixed`, `migration_unavailable`, `no_scheduled_resume`, `switch_selection_required`, `reset_time_unknown`, `recovery_in_progress`                                                                                                                                                                    | none                                                                                                                                                     | `queue-commands.ts`            |
| `thread_exists`, `permission_parent_not_found`, an `AccessError` code or `permission_ceiling_unverifiable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | none                                                                                                                                                     | `spawn`, `index.ts:621`–`:640` |

Successes: `{commandId, ok: true, threadId}` for create, prepare, send and every thread command;
`{commandId, ok: true}` (no `threadId`) for archive and every queue command.

Strings that are not `CommandResult`s, and stay byte-exact:

- `admitCreation` returns a string: `daemon_shutting_down`, `engine_starting`, then
  `validateCreation`'s error, then `acquire`'s `invalid_command`, `thread_creation_in_progress`,
  `thread_exists`, `engine_capacity_exceeded` (`creation-admissions.ts:19`–`:24`).
- `queuePage` **throws** `Error("queue_conflict")`, `Error("queue_revision_required")`,
  `Error("invalid_queue_cursor")`, in that order of checks (`queue-store.ts:269`–`:279`). The
  facade throws a plain `Error` with that message, because callers (`services/recovery.ts:148`)
  match it.
- Stored intent errors: `Cancelled before delivery` (Stop), `Cancelled by queue pause`,
  `Removed from queue`; `commandFailure` falls back to `Not delivered` and `inputFate` to `Not sent`.
- Thrown inside the engine: `Missing queue metadata`, `Invalid queue entry`,
  `Invalid intent identity`, `Provider reused an input message identity for a different command`,
  and the input-text errors listed under E5.4b.

### Commands as stored

The `intents.payload` column is `JSON.stringify(command)`. Where the TypeScript ran the command
through `Command.parse` first (`recovery.admit`, `withoutRestatedSelection`, `admitSteer`,
`queue.edit`, `queue.resend`'s replacement, `acquire`'s normalized command, `spawn`, and
`personCommand` in the shell), zod strips unknown keys, applies defaults and orders keys as the
schema does (porting rule 8). Where it did not (a `thread.create` that `validateCreation` returns
unchanged), the stored text keeps the command as it arrived. The Rust does the same: decode with
`ace-protocol`'s `Command` and serialize in schema order exactly where the TypeScript parsed, and
pass the arrived `ace_json::Value` through untouched where it did not. Byte length matters,
because `queuePage`'s 512 KiB budget and the admission budgets measure it.

## Creation

- **Two phases.** `admitCreation` (`index.ts:1095`) validates, then `acquire` reserves a slot and
  holds the thread id for an owner across the server's asynchronous Git preparation. The receipt
  (`handler.ts:209`) accepts only the same owner with the same command: `authorized` compares the
  owner by identity and the command by `JSON.stringify`, or accepts an unowned command when no
  owner holds the id (`creation-admissions.ts:42`–`:48`).
- **The owner across the boundary.** The facade's `admitCreation` creates the owner as a fresh
  JS object, gives it a numeric id from a counter, keeps a `WeakMap<object, number>`, and passes
  the id to Rust. `CommandContext.creationOwner` is mapped back through the same map before the
  binding call. `release()` calls the binding with the id, and Rust deletes the owner only if it
  still matches (`:31`–`:35`). An object the map doesn't know is "no owner".
- **`validateCreation`** (`creation-validation.ts:14`–`:129`) runs in both phases, in its order.
  Its `directory` is the `workspaceDirectory` port, which throws for a missing or non-directory
  path (`workspace_unavailable`). The handoff branch (`:84`–`:104`) calls the `portableHandoff`
  port with the source thread id and `readBoundedItemPage(id, MAX_SAFE_INTEGER, 100, 262144)`'s
  bounds, and gets back what `portableContext` returns. The port reads the page itself, so no
  history crosses into Rust.
- **The receipt's create** (`handler.ts:206`–`:375`) keeps its order: authorized, validate, model
  selection, the pull-request and prepared-workspace checks, slot (skipped for `thread.prepare`),
  `createEngineThread`, the forge links through the `linkCreatedThread` port (PR link and status
  when prepared from a PR; the issue link for `thread.create` with `issue`), the handoff context
  and its synthetic `handoff:<commandId>` input, the history grant (stub). A `thread.prepare`
  releases its slot and returns at `:370`.
- **`createEngineThread`** (`create-thread.ts`) writes, in order: `permissions.ensure` (twice, as
  today: `:33` and inside the `Thread`), the `Thread` (parsed, so schema order), `thread.hasSentMessage = false`,
  `repo.save(state, [thread.created])`, the session row (prepared or unprepared), `queue.ensure`,
  `transitions.set`, `transitions.remember`.
- **Title.** `p.title`, else `provisionalTitle(p.input)` for create, else `New thread`. The source
  is `agent` for a prepare that says so, `person` for any explicit title, else `provisional`
  (`:271`–`:279`).

## Queue semantics

- **Queued and steered.** `delivery: "queue"` waits for the root's run to end; `"steer"` joins the
  running turn, and with no turn running starts the next one (ADR 0053, 2026-10-17 and -18). An
  omitted delivery on `thread.send` becomes the thread's `followUpBehavior` (default `queue`) at
  admission. `thread.create` and every non-send intent store `queue` (`intents.ts:84`). A steer
  aimed at a run that has ended, or at a run other than the one now running, queues instead
  (`fenceSteer`). A steer that changes model or options is split by `admitSteer` into the send
  and a queued switch.
- **What counts.** `pendingCount` (`queue-store.ts:186`) counts sends and creates waiting
  (`pending`, `queued`) plus uncertain sends and continuations, but **not** child results
  (`trigger = 'subagent_result'`). A live continuation adds one unless it is uncertain.
  `waitingSends` counts child results too. Snapshot, page, `head`, `editable` and `move` never
  show or touch a child result. `prioritizeSubagentResult` puts a child result at position 0
  without a revision bump.
- **Capacity.** 256 inputs in flight per thread (`maxMessages`, counted by `inputCapacity`:
  waiting, sending, or sent and awaiting acknowledgement; an uncertain one does not count), 256
  KiB per command, at most 64 parts per message.
- **Revision.** Every `queue.set` increments `revision` and appends `queue.updated` (with a snooze
  wake first when one applies), so an empty patch is a revision bump. Every queue command
  compares `expectedRevision` inside the receipt (`queue_conflict`). Claimed messages are
  immutable (`message_already_claimed`).
- **Holds.** `paused` with a `reason`: `stopped`, `restart`, `manual`, `limit`, `snooze`,
  `uncertain`, `not_sent`, `model_unavailable`. `limited`, `resetAt`, `resumeAt` and `timerAction`
  (`resume`, `snooze`, `migrate`, `clear`) hold the limit and its deadline. `holdToken` increments
  on every hold change, so a continuation holding an older token does nothing (`owns`, `begin`,
  `release`). `lastFailure` clears when a hold is released or replaced by a reason other than a
  failed send. `exited` follows `exitedAfter` (`queue-store.ts:37`) and is shown only when true.
  `shown` hides `resumeAt` for a `clear` deadline.
- **What releases a hold.**
  - A new `thread.send` releases `stopped` and `restart` holds, unless the queue is limited, has
    uncertain inputs, is recovering, or is a Cursor SDK `restart` hold (`releaseInterruptedHold`).
    It also releases a `limit` or `snooze` hold, or the `clear` marker (`manual` with `resetAt`),
    unless uncertain or recovering (`releaseLimitHold` → `lift`). And it retires every uncertain
    input, keeping a Cursor SDK continuation (`retireUncertainInputs`).
  - Removing or editing the head message of a `not_sent` or `model_unavailable` hold releases it,
    if there is no continuation and no limit (`queue-commands.ts:37`–`:43`).
  - Resending the last uncertain input releases an `uncertain` hold, never a pause, limit or
    continuation (`:130`–`:141`; `reconcileUncertainty`).
  - `queue.pause` fails pending resume intents (`Cancelled by queue pause`) and holds `manual`,
    keeping `resetAt` only while limited.
  - `thread.resume`, `queue.resume` and `thread.limit` (resume now, switch, migrate) add a
    recovery intent and hold the queue under its current reason (or `manual`) until it runs.
    `resume_at_reset` and `snooze_until_reset` set a deadline from the account's reset, else the
    stored `resetAt`, refusing one in the past (`reset_time_unknown`). `cancel_resume` turns a
    scheduled resume back into a `clear`.
- **Persistence.** Everything above is in `engine_queue`, `intents`, `engine_queue_attachments`
  and `engine_steer_notes`, written in the receipt's transaction. A queued message is not in the
  transcript: its user item is created when delivery claims it (`admitInput`, ADR 0065).
  Attachments are tracked per live intent and pruned when the intent is done or failed and no
  longer awaiting or uncertain, which is what `retainsAttachment` reads.
- **Stale inputs** (`stale-inputs.ts`). An uncertain input stays in the queue as "may have run"
  and holds it (`uncertain`) until it is retired. Two things retire it: the provider ending a turn
  in the session it was submitted to (`retireEndedTurnInputs`, called from the fold), or a new
  message (`retireUncertainInputs`). A retired input clears `uncertain` and is pruned; it is never
  sent again, and its transcript notice stays. Only the `uncertain` hold lifts; a limit or
  continuation reconciles its own reason, and any other hold gets a revision bump so clients drop
  the entry.
- **Input fate** (`input-fate.ts:43`), checked in this order: replaced (by the resend's command),
  uncertain, waiting (`pending`/`queued`), delivered with its run, failed (`removed` for
  `Removed from queue`), delivered (written), else by intent status: unknown, sending (`running`),
  delivered (`done`).

## Intents and their journal

- **The `intents` table** holds each accepted command: `command_id`, `thread_id`, `kind` (the
  payload type), `payload` (the stored command), `status` (`pending`, `queued`, `running`,
  `done`, `failed`), `attempts`, `awaiting`, `ack_target`, `delivery`, `acknowledged`, `trigger`,
  `submitted_generation`, `resolution_generation`, `resolution_id`, `position`, `uncertain`,
  `error`. Its schema is E5.3's (migrations); its statements are E5.4a's.
- **Dispatch order** is `(position, id)` within a kind group: recoveries (`thread.resume`,
  `queue.resume`, `thread.limit`) before deliveries (`thread.create`, `thread.send`,
  `thread.fork`, `thread.switch`, `thread.merge`); `transition` puts switch before merge; the
  person's steer goes ahead of ace's (`personSteer`). Controls are everything else, `pending`, up
  to 64 at a time. `runnableThreads` excludes threads with a slot, a foreign transition guard or a
  fenced ownership.
- **The sends worker's choice** (`work`, E5.4f), after `actor.flush()`: poisoned actors fail
  their waiting intents with the two fixed messages (`index.ts:1306`–`:1311`); a reserved
  workspace or a fenced thread waits; a ready transition runs first; then a recovery; then
  nothing while a recovery acknowledgement is outstanding or the queue is held; then the first
  message, which is a child result when a transition heads the queue, else the yielded steer,
  else the queued message when the head is a steer and a root run is active, else the head. It is
  marked `queued`, the queue is synced, and it goes to delivery only when nothing is awaiting and
  `readyForInput` holds.
- **`readyForInput`** (`message-facts.ts:67`): a child result waits for the whole tree
  (`readyForChildResults`); a quiescent thread takes anything; a selecting send waits while
  provider work runs; otherwise the derived status is `new`, `done` or `failed`, or the send is
  the person's or a parent agent's with no selection and the root accepts person input.
- **Lifecycle writes**: `add` (pending, at `queue.position`), `claim` (running, `attempts + 1`),
  `beginSend` (the acknowledgement target, and the continuation record for recoveries), `submit`
  (generation), `joinRunningTurn`, `defer`, `requeue` (back to a plain queued message), `mark`
  (done or failed, pruning attachments). E5.4a ports them all; E5.5 calls the delivery ones.
- **The input journal** (`engine_inputs`, `engine_input_echoes`, `engine_input_identities`,
  `engine_input_replacements`) correlates provider echoes with accepted inputs without scanning
  history (behaviour.md §9). `register` at acceptance stores the signature of the person's parts
  and the origin. `sending` at delivery re-signs with the provider's own rendering (Claude's first
  admission, Pi's message) and the generation. `correlate` on each root user-message fact matches,
  in order: a native identity (`identify`), an echo alias, then the oldest unmatched sent input of
  that generation with the same signature. It rewrites the fact to the input's key with its
  origin, `synthetic: !personInput(origin)` and the provider's `nativeId`, and drops the
  provider's parts, so the person's original parts stay.
- **Runs.** `attachRun` binds an input to the run it steered into; `bindSent` gives every sent,
  unbound input of a generation to the run that started; `bindConsumedInput` moves a steer the
  provider reports consumed by another run, deleting and re-creating its item when it moves off a
  finished run.

## Ace-input attribution

ace's own inputs (child results, notices) carry origin only through ace's persisted command,
never through native content (`ace-input-attribution.ts:13`). `AceInputs.record` keeps, per
`(thread, command)`, the agent, the item key and up to 64 delegation outcomes. When a native
transport echoes a user-role message whose origin is `subagent_result` with a `commandId`,
`attribute` replaces it with a `delegation.settled` item for the recorded agent and item:
`complete: true`, the results, `delivery: "ace-input"`, `origin: "ace"`, and the echo's `raw` if
it had one. An echo on another agent, or with no record, passes unchanged. `admitInput` skips the
user item for a child result that has a record (`transcript-inputs.ts:106`), so the result shows
once, as its settled delegation. `aceWaitFact` marks a running ace `wait` (or `delegate` with
`waitSeconds`) as `subagents.waiting` on `ace-child:<threadId>` targets, once per item.

## Seams: landing without E5.2 and E5.3

- **E5.4a and E5.4b** use only E5.1's `EngineStore::atomic` and `Tx` and their own tables. Their
  cargo tests open a temp `ace_store` database (the event database schema, created by
  `ace-store`'s open), run `queue::open`, `intents::open` and `inputs::open`, seed rows with SQL
  copied from the statements under test, and assert results. The facade reads of E5.4a work
  before E5.3 because reads don't wait for `ready()`, and the probe's `emptyCandidates()` lets
  `ready()` resolve.
- **E5.3's `Repo`** is the API E5.4c to E5.4f call: `state`, `require_state`, `apply`, `save`,
  `evict`, `reserve`, `release`, `reserved_slot`, `create_session`, `create_unprepared_session`,
  `session`, `backend`, `cleaning`, `native_entity`, `entity_thread`, `reserved`, `workspace`,
  `next_command_id`, and the store reads (`get_thread`, `get_workspace`, `read_item_page`,
  `read_bounded_item_page`, `item_created_seq`, `historical_item_count`, `workspace_reservations`,
  `append_events`, `is_history_writing`, `record_command`). If E5.3 names one differently, use
  E5.3's name. Never add a method to E5.3's files; ask for it in E5.3's review.
- **E5.2** calls E5.4b's three functions on the frame path, and `stale::retire_ended_turn_inputs`
  and `transcript::bind_started_run` / `bind_consumed_input` from the fold. E5.4f calls E5.2's
  `Actor` (`flush`, `poisoned`, `persistence_failed`, `schedule`, `sync_queue`, `stop`, `backlog`,
  `idle_due`, `session`).
- **Proof before the (a) files can pass** goes through E5.1's seam. Seam tests live in
  `native-engine/commands.test.ts` (in process, switch on) and
  `native-engine/commands-home.process.test.ts`. The second is for homes the TypeScript engine
  wrote (`engineSeam({ seedWithTypeScript })`, one seeding script per case under
  `native-engine/testing/`). Each names in a comment the (a) test that will show the same thing,
  and is deleted in the commit where that file first passes natively (E5.1 step 12).

## Proof

### The 31 class (a) files

Each is run alone, unchanged, switch off and on (rule 3). "Proves" is the sub-item whose code
the file mostly covers; "first native green" is the earliest item after which it can pass with
the switch on. Most of them deliver, and that is E5.5 and E5.6. These are expected results, read
from the files. Each sub-item runs its files, records the real result, and amends this table and
E5.1 step 12's in its PR.

| File (`*.process.test.ts`) | Proves   | First native green                                                             | Why                                                             |
| -------------------------- | -------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `metadata-commands`        | E5.4e    | **E5.4e**                                                                      | Archive receipts and `not_implemented`; opens no session.       |
| `chat-thread`              | E5.4e    | E5.4e if the delivery stub's single report doesn't fail the harness, else E5.6 | A create receipt's details; the woken send reaches E5.5's stub. |
| `guest-admission`          | E5.4d    | E5.7                                                                           | Seeds through `engine.guests.create`.                           |
| `queue-capacity`           | E5.4a    | E5.6                                                                           | Inputs awaiting admission need a session.                       |
| `input-leases`             | E5.4a    | E5.6                                                                           | Attachment retention across sends and steers.                   |
| `queue-context`            | E5.4a, d | E5.8                                                                           | Pages and edits; `:54` restarts.                                |
| `late-admission`           | E5.4b    | E5.6                                                                           | Late correlated admission.                                      |
| `catalog-mentions`         | E5.4b    | E5.6                                                                           | Native-command inputs and their signature.                      |
| `command-catalog`          | E5.4b    | E5.6                                                                           | Same, over the socket.                                          |
| `input-fate`               | E5.4c    | E5.6                                                                           | Fate after real deliveries.                                     |
| `queued-run-binding`       | E5.4c    | E5.6 (steer cases E5.5)                                                        | `admitInput`, `bindStartedRun`, `bindConsumedInput`.            |
| `wake-run-inputs`          | E5.4c    | E5.6                                                                           | Origins of woken runs.                                          |
| `agent-trigger-admission`  | E5.4c    | E5.6                                                                           | Origins by trigger.                                             |
| `thread-title`             | E5.4c, e | E5.6                                                                           | `:45` and `:113` replay provider titles.                        |
| `stale-inputs`             | E5.4d    | E5.6                                                                           | Retirement after a real turn end.                               |
| `submission`               | E5.4d    | E5.6                                                                           | Uncertain copies after exits.                                   |
| `held-send-release`        | E5.4d    | E5.6 (`:184` E5.8)                                                             | Failed-send holds.                                              |
| `queue-resend-route`       | E5.4d    | E5.6                                                                           | Resend through the server route.                                |
| `queue-recovery`           | E5.4d    | E5.8                                                                           | `:386` and `:418` restart.                                      |
| `admission-recovery`       | E5.4d    | E5.8                                                                           | Continuations across restart.                                   |
| `acknowledged-response`    | E5.4d    | E5.6 (`:95` E5.8)                                                              | Acknowledgement before the daemon stopped.                      |
| `defaults`                 | E5.4e    | E5.6                                                                           | Model defaults through the `models` port.                       |
| `client-model-defaults`    | E5.4e    | E5.6                                                                           | Same.                                                           |
| `model-selection`          | E5.4e    | E5.6                                                                           | Same; `:174` steers (E5.5).                                     |
| `worktree-title`           | E5.4e    | E5.6                                                                           | Prepared workspaces and provider titles.                        |
| `organization`             | E5.4e    | E5.10                                                                          | PR settle.                                                      |
| `pr-settle-once`           | E5.4e    | E5.10                                                                          | Same.                                                           |
| `switch-admission`         | E5.4e    | E5.9                                                                           | Switch admission (stubbed in E5.4).                             |
| `queue-selection`          | E5.4d    | E5.9                                                                           | Selecting steers split into switches.                           |
| `queue-transitions`        | E5.4d    | E5.9                                                                           | Fork and switch of held queues.                                 |
| `overload-delivery`        | E5.4f    | E5.8                                                                           | Mailbox overload, `restart=true` reopens.                       |

Seven of these also appear in later items' rows (`submission`, `input-fate`, `input-leases`,
`held-send-release` in E5.5's, `guest-admission` in E5.7's, `model-selection` in E5.6's,
`switch-admission` in E5.9's). A file is green when it first passes, whichever item that is.

### Class (b) cases to move

- `edited-context.test.ts` (four cases) → `#[cfg(test)]` in `rules.rs` (E5.4a).
- `retired-bot-threads.test.ts` (two cases) → `commands/guest.rs` (E5.4d).

Same inputs and expectations; the TypeScript files stay until their modules are deleted.

### Named tests

Seam tests (switch on, `describe.runIf(engineBackend() === "native")`; each deleted when the (a)
test in its comment passes natively):

- E5.4a, `commands-home.process.test.ts`:
  - "a queue the TypeScript engine wrote reads the same natively: snapshot, first page, next page,
    total" (seeded: three queued sends, one uncertain, one child result, a `stopped` hold; asserts
    literal values: the child result absent, the uncertain message `state: "uncertain"`, `exited`
    absent, `next` set). (a): `queue-context.process` `:15`.
  - "a page refuses a stale revision, a cursor without a revision and an unknown cursor, with the
    TypeScript messages". (a): `queue-context.process` `:15`.
  - "commandFailure and commandExecution read a removed, a cancelled and a done intent".
    (a): `input-fate.process` `:38`.
- E5.4c, `commands-home.process.test.ts`:
  - "inputFate natively reads waiting, removed, replaced and delivered inputs of a
    TypeScript-written home". (a): `input-fate.process` `:8`, `:38`, `:66`.
- E5.4d, `commands-home.process.test.ts` and `commands.test.ts`:
  - "queue edits on a TypeScript-written queue commit natively with their receipts: edit, move,
    remove, pause, each a single revision bump with one `queue.updated`". (a):
    `queue-recovery.process` `:17`.
  - "two receipts on one revision: the first wins, the second gets `queue_conflict` and commits
    nothing". (a): `queue-recovery.process` `:73`.
  - "removing the failed head releases a `not_sent` hold; removing one behind it keeps the hold".
    (a): `held-send-release.process` `:62`, `:93`.
  - "a guest thread and Spade's threads refuse with their titles and details" (seeded with the
    TypeScript engine, since `guests.create` is E5.7's). (a): `guest-admission.process` `:5`.
  - "a refused receipt commits nothing and releases no wake" (the probe's `woken()` is empty and
    `headSeq` unchanged). (a): `metadata-commands.process` `:54`.
  - "a receipt whose policy throws after accepting rolls back, and its wake never runs".
    (a): `engine/reliability.process` (the receipt cases).
- E5.4e, `commands.test.ts`:
  - "create, send and Stop receipts write their intent, queue and title rows natively, and the
    Stop holds the queue as `stopped` and cancels the waiting send". (a):
    `queued-run-binding.process` `:324`, `stop-queue.process`.
  - "the receipt's refusals win in the TypeScript order": a table over seeded conditions for
    `thread_deleting`, `cursor_cli_retired`, `workspace_change_in_progress`, `message_too_large`
    (65 parts), `not_implemented`, `thread_not_found`, `agent_not_found`, `stale_interrupt`,
    `unsupported_goal`, `engine_capacity_exceeded` (`maxActiveThreads: 1`) and
    `queue_capacity_exceeded` (256 in flight). Each row asserts the whole result object.
    (a): the commands row.
  - "a receipt that reaches an unported branch fails NotPorted naming the item, and commits
    nothing" (`thread.fork` → E5.9). Deleted with E5.10's switch-on run.
  - "admitCreation holds the id for its owner; a second admission, a foreign owner and a changed
    command are refused; release frees the slot". (a): `worktree-title.process` `:12`.
- E5.4f, `commands.test.ts`:
  - "a send on a held queue is marked queued and never reaches delivery" (`onError` empty) and
    "a runnable send reaches delivery, which reports E5.5 once". (a): `queued-run-binding.process`
    `:57`.

Cargo tests (in the module beside the function, new behaviour only where marked):

- `queue/record.rs`: `exitedAfter` over every `(before, patch)` combination; `lastFailure`
  clearing; `shown` hiding `resumeAt` for `clear`.
- `queue/page.rs`: the 512 KiB cut keeps the first message whatever its size; `next` only when a
  row was left; the subagent-result exclusion.
- `queue/store.rs`: `move` (to front, after a message, unknown, itself); `reconcileUncertainty`'s
  reason table.
- `ace-json::bounded`: the four limits at their boundaries (moved with the function).
- `inputs/signature.rs`: `withoutHandoffEnvelope` with a v1 JSON manifest, a tagged envelope, an
  invalid manifest, a too-long envelope, and a multi-byte prefix (UTF-16 counting). New: no (a)
  file reaches the invalid and too-long branches. The commit says so.
- `inputs/journal.rs`: correlation by identity, by alias, by signature within a generation, by
  signature with no generation (`IS NULL`), and the identity-reuse error.
- `commands/admissions.rs`: `authorized` with no owner, the right owner, a foreign owner, a
  changed command.

## Benches and the cross-mode run

- E5.4 cannot run `bench/head-of-line.ts` switch-on: no send is delivered until E5.6. Each of
  E5.4d and E5.4e reports one figure instead: the receipt's own time, p50 and p99 over 10,000
  `thread.send` receipts to one thread on a held queue (nothing delivers), switch off and on, from
  a loop in the seam test file (`--bench` filter, not run by default). That covers `sendReceipt`'s
  synchronous part. E5.8 runs the full bench.
- The E5 cross-mode list needs restart (E5.8). Before that, `commands-home.process.test.ts` is the
  cross-backend proof that E5.4's reads and receipts work on TypeScript-written homes. The reverse
  direction (a home written natively, read by TypeScript) is the cross-mode run's.

## Files (all yours; nothing else)

- `native/daemon/crates/ace-engine/src/{intents,queue,inputs,commands}/…` and `rules.rs`; the
  four module roots replace E5.1's stubs (`commands.rs` keeps `Commands` and `quiescent`, which
  E5.4f fills: a thread with a running sends task is not quiescent).
- In later items' files, only what "The receipt path" lists: `steering/{selection,notes}.rs`,
  `liveness/stop_intents.rs`, `transitions/state.rs`, `access/storage.rs`, and the stubs. Each such
  file starts with `//! Ported by E5.4<x> for the receipt path; owned by E5.<n>.`
- `ace-core/src/{person_input,provider_admission}.rs` (open question 6),
  `ace-projection/src/attention.rs` (the queue branch), `ace-adapter-claude/src/input.rs`,
  `ace-adapter-pi/src/input.rs`, `ace-json/src/bounded.rs` and the one re-pointed call in
  `ace-adapter-cursor`.
- Bindings: `ace-daemon-node/src/engine/{intents,queue,inputs,commands}.rs`. Shell:
  `apps/daemon/src/native-engine/{intents,queue,inputs,commands}.ts`, `commands.test.ts`,
  `commands-home.process.test.ts`, `testing/` seeding scripts; in E5.4e, the three ports in
  `ace-engine/src/ports.rs`, `ace-daemon-node/src/engine/ports.rs` and `native-engine/ports.ts`.
- `docs/engine/porting-guide.md` (this brief's link and the row corrections) and E5.1's step 12
  table, amended per sub-item.

## Must not

- Edit E5.2's or E5.3's files, or any TypeScript engine module (the switch-off path stays
  byte-identical; `git diff origin/ace/daemon-rust-rewrite -- apps/daemon/src/engine` is empty).
- Make an unported branch succeed, or return a `CommandResult` for one: it fails `NotPorted`, and
  the receipt rolls back.
- Run a wake, a spawn or a task inside the receipt; every wake goes on the after-commit queue.
- Call a JS port while holding a `with_state` borrow, or hold a transaction across an await.
- Change a table, column, index, statement text or JSON shape; reorder the receipt's checks.
- Copy a package helper's TypeScript tests into Rust, or add a parity harness.
- Run the full suite, `bun run check`, or any tier; one file at a time (rule 3).

## Reviewer checks

- The receipt's checks are in `handler.ts`'s order; the refusal table's rows match their sources
  character for character (`detail` with the guest name and its fallback included).
- `queuePage` throws plain `Error`s with the three messages; `admitCreation` returns strings.
- Every `Command.parse` site of the TypeScript is a schema-order serialization in Rust, and no
  other site is.
- The receipt-path table matches the code: every "port" exists in the named file with its header
  line, every "stub" fails `NotPorted` with its item, and the guide's rows for E5.5, E5.7, E5.8,
  E5.9 and E5.10 drop what moved.
- `recovery::fire` reports and never throws; `schedule` cancels the previous timer before arming.
- The owner map is a `WeakMap`; an unknown owner object is "no owner".
- The sends worker re-reads the queue and the transition guard after `actor.flush()`.
- Each seam test names the (a) test that replaces it.

## Open questions, with recommendations

1. **Port the receipt path across items' modules (decision 2)?** The alternative is that every
   native create, send and Stop fails until E5.7, E5.9 and E5.10 have landed, so the commands row
   shows nothing until the end of E5. **Recommend yes**, with the owners keeping the code and their
   rows amended, as listed. The cost is about 450 lines of other items' code in E5.4d and E5.4e.
2. **`Recovery`'s command path to E5.4 (decision 4)?** **Recommend yes.** Every queue command and
   send goes through it, and E5.8 is three items later. E5.8 keeps captures, limit observation
   and deadline firing.
3. **`readMessageFacts` and the `messageFacts` member to E5.5?** **Recommend yes**: its rules are
   `steer-yield`'s. E5.4f keeps `readyForInput` and `threadCapabilities` for the sends worker.
4. **Is six rounds right?** Folding E5.4f into E5.5 would save a round, but E5.1 gave the sends
   lane's `run` to E5.4, and E5.4's seam test needs the worker's hold checks. **Recommend six**,
   with E5.4a and E5.4b in parallel with E5.2 and E5.3.
5. **Three new synchronous ports (decision 5): `workspaceDirectory`, `portableHandoff`,
   `linkCreatedThread`.** `ports.rs` is E5.1's file, which is in review now. **Recommend adding
   them in E5.1's current review round**, so no later item edits `ports.rs`. Failing that, E5.4e
   adds them in one commit with a reviewer from E5.1. A Rust `canonicalize` was rejected because
   on macOS it returns the on-disk case and on Windows a `\\?\` prefix, which `realpathSync` does
   not, and both change the stored worktree path.
6. **Where the pure package helpers go in Rust.** **Recommend by owner**: `acceptsPersonInput`,
   `continueMessage` and `providerCommandDisabled` in `ace-core` (they are `@ace/core` exports
   that E4 left TypeScript-only); Claude's and Pi's provider-input text in their adapter crates;
   `boundedJson` in `ace-json`, replacing the private copy in `ace-adapter-cursor`; the queue
   branch of `threadAttention` in `ace-projection`; `provisionalTitle`, `withoutHandoffEnvelope`,
   `nativeCommandInputs`, `aceWaitTargets`, `cursorInstanceId`, `reportedOrTable` (the paths read)
   and `worktree-base` in `ace-engine`. They are proven by the (a) files, with no copied cases. The
   TypeScript originals stay, because the web app, iOS and the TypeScript adapters use them. That
   leaves two implementations of each until the clients move, which ADR 0223 accepts for the
   engine but did not list for these packages. The owner should confirm.
7. **Open-time work that grows with history (decision 9).** Two of the constructors break
   ADR 0170. `QueueStore` re-tracks attachments by scanning every live input
   (`queue-store.ts:84`–`:93`). `InputJournal` deletes orphans with `NOT IN (SELECT id FROM
threads)` over the whole journal (`input-journal.ts:97`–`:98`). **Recommend porting both
   unchanged** (formats and behaviour are contract in ADR 0223 §5), timing native open on a large
   home with a cold cache in E5.3's measurement, and filing one change, for both backends, that
   moves both into idle bounded batches (ADR 0170).
