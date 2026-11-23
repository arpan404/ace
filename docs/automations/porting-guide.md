# Porting automations work to Rust

For the builder who moves the automation run executor and monitor to Rust (ADR 0225, A1). Read
[ADR 0225](../adr/0225-devices-screens-automations-and-the-mcp-server-move-to-rust.md) and
[behaviour.md](behaviour.md) first: the contract there is what you keep, and behaviour.md §5 lists
every test file by class. The engine's [porting guide](../engine/porting-guide.md) sets the rules
for daemon crates; where this guide is silent, follow it.

A1 starts only once ADR 0223 E5 is default-on (`ACE_ENGINE=native`): the run monitor's work is
reading engine and thread-tree state, and through the TypeScript `Engine` facade it would gain
nothing. Branch from the rewrite branch then, as `ace/rust-automations-a1`.

## What is not ported

The scheduler stays TypeScript: `@ace/automations` (`AutomationService`, `AutomationStore`,
recurrence, calendar, admission, GitHub polling, webhooks). It costs microseconds per decision
with one timer; `compileSchedule` and the calendar also run in `packages/ui-core` and
`packages/fake-daemon`, which must stay JavaScript; and its zone rules come from ICU through
`Intl`, which a Rust zone database could contradict (ADR 0225 question 6). Don't port it, and
don't add `tokio-cron-scheduler` or any cron crate. `AutomationService` calls its executor
exactly as today.

## Rules for A1

1. **Same TypeScript interface.** The boundary is `AutomationExecutor`
   (`packages/automations/src/contracts.ts:32`): `execute(input, signal)` resolves
   `{threadId, status, result}` only when the run's whole tree is over; `recover(key, signal,
input?)` resumes following existing work, undefined when nothing was sent; `interrupt(input)`
   resolves once the stop is held durably. Timing, error classes and the moment each promise
   settles are contract.
2. **One switch, one line.** `ACE_AUTOMATION_EXECUTOR=native`, added to
   `packages/provider-kit/src/native-switches.ts`; it refuses to start without `ACE_ENGINE=native`.
   The shell is chosen by one `if` at the top of `automationRunExecutor`
   (`apps/daemon/src/automation-run-executor.ts:44`), which both the person's executor
   (`automation-executor.ts:50`) and agent-made automations' (`agent-control/owner-thread-executor.ts:32`)
   call. Their `AutomationTarget` stays TypeScript: it builds the run's command inside the
   admission write, so the Rust executor calls it back on the JS thread inside the store's
   transaction, as the engine calls its ports (engine porting guide, E5).
3. **No new tests.** The (a) files below are the proof; you don't edit them. One at a time:

   ```sh
   f=apps/daemon/src/automation-durability.process.test.ts
   test -f "$f" && ACE_STORE=native ACE_ENGINE=native ACE_AUTOMATION_EXECUTOR=native bun --bun x vitest run "$f" --maxWorkers=4
   test -f "$f" && ACE_STORE=native ACE_ENGINE=native bun --bun x vitest run "$f" --maxWorkers=4
   ```

   Never run the full suite, `bun run test`, `bun run check`, `test:process`, `test:slow` or
   `test:changed`.

4. **(b) cases move.** `automation-run-rules.test.ts`'s cases go into `#[cfg(test)]` beside
   `decide_run`, `run_tree_state` and `stop_plan`, unchanged. Delete the TypeScript test only with
   its module, after default-on.
5. **Priority 1, rule for rule.** Port `automation-run-rules.ts` in its order: `runTreeState`
   (`:45`), `decideRun` (`:122`), `stopPlan` (`:211`). A run is never succeeded while any part of
   its tree works, waits on the person or is uncertain; a human wait or a background task keeps
   `execute` pending.
6. **Rows stay as they are.** `automation_threads` and the run records (`RunRecords`,
   `automation-run-record.ts:50`) keep their tables, columns and JSON; a run one backend started,
   the other must recover after a restart. Statements go through `ace-store` on the main
   connection (ADR 0222 §3), never a second connection.
7. **Text stays TypeScript.** The run's `result` is read from the thread and returned untouched;
   thread titles (`automationThreadTitle`, `automation-executor.ts:178`), launch settings
   (`runSettings`, `launchChoices`) and refusal strings are computed in TypeScript and passed in.
   `ExecutionResult` is still parsed by its Zod schema in the shell.
8. **Same numbers.** Reconcile every 5 s (`reconcileMs`, `automation-run-monitor.ts:26`); a stop
   sent 5 times before the run says it can't be stopped (`stopTries`, `:28`); each read touches
   only the turn's own rows (`automation-run-facts.ts`).
9. **JSON through `ace-json`**, clock and ids from the engine's ports, no `unwrap`, no `unsafe`:
   engine porting guide rules 6 to 9.

## Files

| Part             | Files (yours)                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust             | `native/daemon/crates/ace-engine/src/automation_runs/{mod,rules,facts,records,monitor}.rs` (a module of the engine: it reads the engine's state and sends through its command path) |
| Binding          | `native/daemon/crates/ace-daemon-node/src/engine/automation_runs.rs`                                                                                                                |
| TypeScript shell | `apps/daemon/src/native-engine/automation-runs.ts` (an `AutomationExecutor` over the handle), the switch line in `automation-run-executor.ts`                                       |

## A1: the run executor and monitor

| TypeScript replaced (`apps/daemon/src/`)                                                                                     | Lines | Proof: (a) files (`apps/daemon/src/`)                                                                                                                                                                                                                                            | (b) cases to move      |
| ---------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `automation-run-executor`, `automation-run-monitor`, `automation-run-facts`, `automation-run-rules`, `automation-run-record` | 1,433 | `automation-durability.process`, `automation-idle.process`, `automation-one-thread.process`, `automation-run-record.process`, `automation-webhooks.process`, `thread-automations.process`, `cli-automation.process`, `cursor-automation.process`, `automation-workspace.process` | `automation-run-rules` |

Also run with the switch on, to prove the service around the executor is untouched: the 25 (a)
files of `packages/automations/src/` (they use executor fakes, so they must pass identically with
or without the switch).

Cross-mode: run the files above that restart a daemon through `scripts/native-cross.ts`, both
ways; a run started by one backend is recovered by the other.

```sh
f=apps/daemon/src/automation-durability.process.test.ts
test -f "$f" && ACE_STORE=native ACE_ENGINE=native bun scripts/native-cross.ts ACE_AUTOMATION_EXECUTOR "$f"
```

Measure, switch off and on: `bun packages/automations/bench/lifecycle.ts`,
`bun apps/daemon/bench/agent-control.ts`, and the daemon's CPU while 20 runs are being followed
(the monitor's 5 s reads).

## When you are done

- Every (a) file above passes alone with the switch on and off; the moved cases pass in
  `cargo test -p ace-engine`; `bun run check:daemon-native` passes; the cross-mode list passes
  both ways.
- Report: the files run and their results, the bench figures off and on, anything in
  behaviour.md that turned out wrong (with the code that shows it), and the one test you added,
  if any, with the behaviour it covers that nothing did.
- Commit and push as you go with `git push origin HEAD:refs/heads/<your-branch>`; never rebase or
  force-push. Every commit ends with exactly `Co-Authored-By: spade <bot@acehq.dev>`.
