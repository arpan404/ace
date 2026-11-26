# Porting automations to Rust

For the builders who move `@ace/automations` and the daemon's automation executor and monitor
into `native/daemon` (`ace-automations`, and a module of `ace-engine` for the executor), one work
item each. Read
[ADR 0225](../adr/0225-devices-screens-automations-and-the-mcp-server-move-to-rust.md) and
[behaviour.md](behaviour.md) first: the contract there is what you keep, and behaviour.md §5 lists
every test file by class. The [devices porting guide](../devices/porting-guide.md)'s rules for
every item apply here unchanged; this guide adds what is particular to automations.

Branch from `ace/daemon-rust-rewrite` once the item's needs are merged, one branch per item
(`ace/rust-automations-<item>`).

## Rules particular to automations

1. **Recurrence and the calendar are Rust** (ADR 0226's amendment of ADR 0225 §4.1): the
   owner's 2026-11-26 decision ports `compileSchedule`, `nextOccurrence`, `zonedCalendar` and
   `grammar` to `ace-automations` too, so the daemon has no JavaScript child for them. The zone
   rules come from `jiff`'s bundled tzdb, with `calendar.rs`'s own probe keeping the
   TypeScript's fold and gap behaviour; `packages/ui-core` and `packages/fake-daemon` keep their
   JavaScript copy for the apps. Do not add a cron crate or `tokio-cron-scheduler`.
2. **One timer, one query.** The service arms one timer on the core's clock for the earliest
   deadline `nextScheduled` returns (`store.ts:314`); arming replaces the previous one. Jitter
   comes from the injected random port (the agent store's is zero), clock and ids from the
   engine's ports.
3. **Both stores open through `ace-store`'s connection factory** (`automations.sqlite`,
   `agent-automations.sqlite`), with today's tables, columns and JSON, so one SQLite library holds
   every file in the process (ADR 0222 constraint 2) and a home either backend wrote opens in the
   other.
4. **Strings are `JsString`, text is exact.** Prompts, titles, trigger variables, GitHub bodies and
   `gh` output are `JsString`; `renderPrompt`'s limit counts UTF-16 units
   (`decisions.ts:13`); refusals ("Skipped: new work was paused.", "New work is paused. Resume new
   work in ace to continue.", `contracts.ts:91`–`:93`; "Missing trigger variable: …",
   `decisions.ts:9`; the org-host refusal, `apps/daemon/src/automation-executor.ts:44`) come from a
   catalog (`native/daemon/catalog/automations.json`, ADR 0225 safeguard 3). `AutomationResponse`, `AutomationRun` and inbox pages serialize in their
   schema's key order through `ace-json` (types from `ace-protocol`'s generator, ADR 0223 E0).
5. **Priority 1 (A2):** a run is never succeeded while any part of its tree works, waits on the
   person or is uncertain. `automation-run-rules.ts` is ported rule for rule, in order.
6. **Webhook secrets and signatures are byte-compatible both ways**, so a home Rust wrote opens
   with the switch off, and the other way round:
   - **Envelope** (`webhook-secret-box.ts:32`–`:51`): `v1.<iv>.<tag>.<ciphertext>`, each part
     standard base64 (with padding, as `Buffer.toString("base64")` writes it), a fresh 12-byte IV
     per seal, the 16-byte GCM tag, AES-256-GCM (`aes-gcm`) over the secret's UTF-8 bytes.
   - **The automation id is the GCM associated data** (`setAAD(Buffer.from(automationId))`, its
     UTF-8 bytes), so a sealed secret moved to another automation's row doesn't open.
   - **Opening reads the envelope as the TypeScript does**: `sealed.split(".")` takes the first four
     parts and **ignores any after them** (`webhook-secret-box.ts:42`); fewer than four, an empty
     part or a version other than `v1` yields undefined. Base64 parts are decoded the way
     `Buffer.from(…, "base64")` decodes: both the standard and URL-safe alphabets, padding
     optional, decoding stopping at the first `=`, other characters skipped; a strict decoder
     would refuse rows the TypeScript opens. The same lenient decoding applies to the signature
     key (`key()`, `webhook-signature.ts:34`–`:39`) and each `v1,` entry (`:64`), where only a
     decoded length equal to the HMAC's is compared.
   - **Opening fails closed and quietly**: a wrong tag, key or id yields undefined, never an
     error; a missing key leaves secrets unreadable and is never replaced on
     open (`load` only); sealing may create it.
   - **Signatures** (`webhook-signature.ts:42`): HMAC-SHA256 (`hmac`, `sha2`) keyed with the
     base64-decoded secret (the `whsec_` prefix stripped when present, `:10`), over the ASCII
     `<id>.<seconds>.` followed by the request body's **raw bytes** (never a decoded or
     re-encoded string); `v1,<base64>` entries, at most 16, compared in constant time
     (`subtle`), one match enough; the tolerance and header rules (`deliveryId`, `timestamp`,
     `:12`–`:13`) as written.
   - **The key file** (`apps/daemon/src/automation-webhook-key.ts:24`–`:65`): `automation-webhooks.key`
     in the data directory, exactly 32 bytes. Create with `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`,
     mode 0600 (then `fchmod` on POSIX); on `EEXIST` read the other store's key. Load with
     `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, so a symlink is refused (`ELOOP`) and a FIFO at the path
     never blocks the daemon; then `fstat` on the open descriptor: a regular file, owned by this
     user, not readable by group or others, exactly 32 bytes, else refused with today's message
     and left as it is. Use `rustix` (`openat` flags, `fstat`) on POSIX and the Windows
     equivalents (no reparse-point following, `FILE_FLAG_OPEN_REPARSE_POINT`) there.
   - Proof, switch off and on, and **across switches**: `webhook-secret-box`, `webhooks`, daemon
     `automation-webhooks.process`; then the cross-mode run of `automation-webhooks.process`
     (secrets sealed by one backend opened and verified by the other, both ways). The (b) cases of
     `webhook-signature`, `webhook-body` and daemon `automation-webhook-key` (symlink, FIFO,
     mode, owner, size) move into `cargo test`.
7. **Never start a real `gh` against GitHub.** The (a) files use fake `gh` processes; keep it so.

## Files per item

| Item | Rust (yours)                                                                          | Binding (yours)                                 | TypeScript shell (yours)                                        | Switch                            |
| ---- | ------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- | --------------------------------- |
| A1   | `ace-automations/src/{store,store_schema,definition,service,scheduler,decisions,github,webhooks,webhook_body,webhook_signature,webhook_secret_box,webhook_key,calendar,grammar,recurrence}.rs` | `ace-daemon-node/src/automations/mod.rs`        | `packages/automations/src/native-service.ts`, `native-store.ts` | `ACE_AUTOMATIONS=native`          |
| A2   | `ace-engine/src/automation_runs/{mod,rules,facts,records,monitor}.rs`                 | `ace-daemon-node/src/engine/automation_runs.rs` | `apps/daemon/src/native-engine/automation-runs.ts`              | `ACE_AUTOMATION_EXECUTOR=native`  |
| A3   | `ace-automations/src/workspace.rs`                                                    | `ace-daemon-node/src/automations/workspace.rs`  | the switch line in `apps/daemon/src/automation-workspace.ts:55` | `ACE_AUTOMATION_WORKSPACE=native` |
| A4   | `ace-automations/src/tools.rs`                                                        | `ace-daemon-node/src/tools/automations.rs`      | the family line in agent-control's automation tools             | `ACE_NATIVE_TOOLS=automations`    |

## Where A1, A2 and A3 end (for the Rust daemon's wiring)

Owned by **A1** (`ace-automations`): recurrence, `zonedCalendar` and grammar (ADR 0226's
amendment moves them here); the definition store (`automation_jobs`, `_state`, `_revisions`,
poll/trigger errors, run history and cancellations); webhook keys, secret box, signatures, body
variables and delivery receipts; the scheduler's one timer, jitter, COUNT cursor, missed-run and
late-run rules; admission, queueing and promotion; `automation.list`/`inbox`/`handle`
envelopes; prompt rendering and every UTF-16 text bound; GitHub polling **decisions** (baseline,
ETags, page snapshots, revision checks, event delivery) over an injected `gh` client, with the
fake processes for tests. A1 leaves three things to its host: arm the one timer from the delay
A1 returns, run `gh` through `ace-supervisor`, and call `backfill_finished_at` from idle in
bounded batches.

Owned by **A2** (`ace-engine/src/automation_runs/`, needs the Rust engine): launching a run's
thread and sending its message, recovery without a second send, the 5 s monitor and its tree
facts, every rule that decides whether a run's whole tree is working, waiting on a person,
uncertain, succeeded or failed, run records, the stop plan and its retries, delivering a durable
cancellation to a running thread, outcome recovery, launch settings/titles, the organization
host refusal, and Cursor automation sessions. A1 only hands A2 `Execute`, `Recover` and
`Interrupt` actions and settles runs when A2 reports their outcome.

Owned by **A3** (`ace-automations/src/workspace.rs`, needs the files tool's Rust backend): the
filesystem watcher itself, path memory per trigger, holding events while a baseline is read, the
reconciliation bound, and durable event keys. A1 owns what happens after delivery: a file
trigger's health, replacement failures keeping the old watcher, readiness by revision, and
admission of the delivered event.

## A1: the scheduler (needs E2, `ACE_STORE=native`)

`AutomationService` and `AutomationStore` become facades over one native handle per store; the
executor, the workspace source, admission and `onRun` stay ports the daemon passes, so today's
daemon executor (and the tests' fakes) run unchanged behind it.

| TypeScript replaced (`packages/automations/src/`)                                                                                                                                                                                                                                  | Proof: (a) files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | (b) cases to move                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `service`, `store`, `runtime`, `lifecycle`, `decisions`, `definition`, `contracts` (`nodeTimer`), `execution-owner`, `cancellations`, `observation`, `github`, `gh-process`, `gh-response`, `webhooks`, `webhook-store`, `webhook-body`, `webhook-signature`, `webhook-secret-box` | all 25: `admission`, `audit-reliability`, `cancellation`, `cas`, `durability`, `gh-process.process`, `github.process`, `jitter`, `lifecycle`, `metadata`, `monitoring`, `outcome-recovery`, `paused`, `polish`, `queue`, `recurrence`, `revision`, `run-options`, `service`, `startup`, `teardown`, `trigger-readiness`, `watchers`, `webhook-secret-box`, `webhooks`; daemon `automation-durability.process`, `automation-idle.process`, `automation-one-thread.process`, `automation-webhooks.process`, `thread-automations.process`, `cli-automation.process` | `webhook-body`, `webhook-signature`, daemon `automation-webhook-key`, `automation-webhook-reach` |

Same limits: 256 running, one waiting per automation, 100 resources a page, 20 pages, 2,000 events
a poll, 30 s and 2 MiB per `gh` request, 60 webhook requests a minute per key over 2,048 keys
(`apps/daemon/src/automation-webhooks.ts:52`), 16 signatures a header. Corrupt rows are isolated,
never fatal. `gh` runs through `ace-supervisor`; cancellation rejects at once and ends its process
group. Cross-mode: `automation-durability.process`, `durability`, `startup` both ways. Measure
`bun run --filter @ace/automations bench`'s files and `bench/poll-admission.ts`, off and on.

## A2: the run executor and monitor (needs ADR 0223 E5 default-on, A1)

The boundary is `AutomationExecutor` (`contracts.ts:32`): `execute` resolves only when the whole
tree is over, `recover` resumes without sending twice, `interrupt` resolves once the stop is held
durably. The switch sits at the top of `automationRunExecutor`
(`apps/daemon/src/automation-run-executor.ts:44`), which the person's executor
(`automation-executor.ts:50`) and agent-made automations' (`agent-control/owner-thread-executor.ts:32`)
both call; their `AutomationTarget` (the run's command, built inside the admission write) moves
with it once the engine's command path is Rust, and until then is called back on the JS thread
inside the store's transaction. Launch settings and titles (`runSettings`, `launchChoices`,
`automationThreadTitle`) come from the catalog or are computed by the TypeScript and passed in.

| TypeScript replaced (`apps/daemon/src/`)                                                                                                                                                                           | Lines | Proof: (a) files (`apps/daemon/src/`)                                                                                                                                                                                                            | (b) cases to move                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `automation-executor`, `automation-run-executor`, `automation-run-monitor`, `automation-run-facts`, `automation-run-rules`, `automation-run-record`, `automation-lifecycle`, `agent-control/owner-thread-executor` | 1,766 | `automation-durability.process`, `automation-idle.process`, `automation-one-thread.process`, `automation-run-record.process`, `automation-webhooks.process`, `thread-automations.process`, `cli-automation.process`, `cursor-automation.process` | `automation-run-rules`, `automation-org-host`, `automation-run-settings` |

Same numbers: reconcile every 5 s (`automation-run-monitor.ts:26`), a stop sent 5 times
(`:28`), reads that touch only the turn's own rows.

**The Cursor recovery case is part of A2's gate**, not an extra: `cursor-automation.process`
(behaviour.md §5, class a) pins that an existing Cursor automation launches on the SDK and that
recovery keeps the same thread. It runs with `ACE_AUTOMATION_EXECUTOR` off and on, with
`ACE_ENGINE=native` and with the Cursor session on either backend (`ACE_SESSIONS` unset and
`=cursor`, ADR 0223 E3), and in the cross-mode list.

Cross-mode: `automation-durability.process`, `automation-run-record.process`,
`cursor-automation.process`, and any other file above that restarts, through
`scripts/native-cross.ts ACE_AUTOMATION_EXECUTOR`. Measure `bench/lifecycle.ts` and
`apps/daemon/bench/agent-control.ts`, and daemon CPU while 20 runs are followed.

## A3: file triggers (needs A1 and the files tool's Rust backend)

`automation-workspace.ts` (`automationWorkspace`, `:55`) over the files service's Rust API, with
its limits (paths remembered per trigger, events held while a baseline is read, the
reconciliation bound) and `WorkspaceChanges`' contract: `receive` resolves after durable
admission, repeated delivery is safe, a failed replacement keeps the old watcher.

- (a): daemon `automation-workspace.process`, package `watchers`, `trigger-readiness`.
- (b): daemon `automation-workspace`.

## A4: the automation tools (needs A1, MCP M2, the agent-control port)

`automation_put`, `automation_remove`, `automation_run`, `automations_list`, in agent-control's
tool catalog (`packages/mcp-server/src/automation-tools.ts`). Descriptors from MCP M1's table;
input decided by the Zod port until the family's typed decoding is pinned (ADR 0225 §4.2);
`automation_remove` keeps `destructiveHint`.

- (a): daemon `thread-automations.process`, `cli-automation.process`, `mcp-tools.process`;
  `packages/mcp-server/src/agent-errors`, `actionable-errors`.

## When you are done

- Every (a) file of your item passes alone with the switch on and off; your (b) cases pass in
  `cargo test` for your crate; `check:daemon-native` passes; the cross-mode list passes both ways.
- Report: the files run and their results, the bench figures off and on, anything in
  behaviour.md that turned out wrong (with the code that shows it), anything you kept TypeScript
  because it couldn't be reproduced exactly, and the one test you added, if any.
