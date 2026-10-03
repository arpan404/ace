# Queue and recovery measurements

Not executed. The owner requires tests and benchmarks to run at merge.

Definitions: `queue.ts` measures SQLite CAS edits with transactional command receipts
and a fixed 128-message held queue; `context.ts` measures a million pure occupancy
transitions; `persistence.ts` measures SQLite context samples and projected events.
`deltas.ts` measures persisted production-translated Codex deltas with 256 large held messages, exercising the
path that skips queue payload decoding on ordinary stream events. Each reports ops/s, microseconds per operation and peak RSS. Runtime numbers need
run at merge. These definitions use controlled data and never open a provider CLI.

Queue messages cap at 256 entries and 256 KiB per message. Pages cap at 32 entries
and 512 KiB of stored command bytes. Reorders touch at most 256 rows. The attachment
index holds only outstanding or uncertain intent references, at most 64 per message.
Context transitions touch one constant-size sample; SQLite stores at most 4096
samples per thread. Deltas skip context and recovery observers. Reset timers use
one indexed next deadline and process batches of at most 64 due threads.

## Planned mutations

All cases below are **not executed (tests run at merge)**.

| Mutation                                            | Behaviour expected to kill it                                 |
| --------------------------------------------------- | ------------------------------------------------------------- |
| Ignore command receipt replay                       | Two-device command replay cannot edit a second time           |
| Drop the restart run trigger                        | Native continuation run records restart as its trigger        |
| Remove queue revision comparison                    | Two devices racing the same revision get one winner           |
| Ignore stored queue position on delivery            | Restart preserves reordering                                  |
| Preserve old attachments on queue edit              | Editing attachments changes surviving deliveries              |
| Delete queued blob references during a restart      | Editing/removing attachments changes durable retention        |
| Let removed messages remain runnable                | Editing, moving and removing queued messages                  |
| Ignore explicit delivery when resolving the default | Configured steer default and queue override                   |
| Claim using a stale command snapshot                | Claimed messages reject concurrent editing                    |
| Always auto-resume a recovered queue                | Restart with auto-continue disabled                           |
| Replay an unacknowledged claimed send               | Unacknowledged sends are never replayed automatically         |
| Omit lost-work text from native continuation        | Crash reports dead shells, monitors and subagents             |
| Clear limited facts on process exit                 | Limits stay distinct from failures after exit                 |
| Fire a reset deadline one millisecond early         | Resume at reset uses the account deadline                     |
| Treat snooze as resume                              | Snooze consumes no quota at reset                             |
| Bind the old account after successful migration     | Move to another account binds native continuation             |
| Release the hold after migration refusal            | Migration refusal retains a held queue                        |
| Drop the hold token check during native open        | Pause during resume fences subsequent sends                   |
| Sum billing tokens into context occupancy           | Occupancy replaces samples and survives billing updates       |
| Keep occupied tokens during compaction              | Context becomes unknown through compaction                    |
| Keep the old sample across session/model changes    | New sessions/models cannot display previous occupancy         |
| Release input leases when a child run ends          | Prepared context survives child completion until root settles |

Further planned mutations, also not executed: discard terminal quota errors; classify
overloaded upstream retries as usage limits; fail to wake delivery when the provider
queue drains without a visible status change; discard a failed unacknowledged send;
allow reordering around an uncertain send; drop automatic continuation after a
temporary actor-capacity refusal; silently skip unavailable attachment preparation.

Review regression mutations, also **not executed (tests run at merge)**:

| Mutation                                              | Intended killing behavior                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| Clear quota on generic retry clearing                 | Surviving real Codex shell output preserves Limited                 |
| Requeue a consumed send on RPC rejection              | Acknowledged input plus quota plus transport exit is never replayed |
| Requeue unacknowledged input on quota or process exit | Missing acknowledgement stays uncertain                             |
| Reserve a slot for a cold held send                   | Capacity-one pause/enqueue/remove permits another thread            |
| Keep an empty resume reservation                      | Capacity-one empty resume permits another thread                    |
| Release a slot while native opening is pending        | Opening barrier refuses another thread at capacity                  |
| Discard context fallback diagnostics                  | Real context resolution emits a warning and sends remaining input   |
| Omit dead-work details from provider input            | Continuation contains shell, monitor and subagent details           |
| Bypass accounts copying or bind before success        | Native history is copied before destination resume                  |
| Ignore native writer locks                            | Locked native migration preserves source binding and history        |

A further capacity mutation removes the close-operation fence; the real WebSocket
pause receipt while native shutdown is gated must still refuse a second thread.
This case is **not executed (tests run at merge)**.

The real-delta benchmark uses the production Codex translator, including its generic
`retry.cleared`, with 256 held messages of 250,000 text bytes each. Queue scheduling
uses indexed lightweight headers and decodes only one claimed payload. Repeated
activity-only facts skip retry/status work when unchanged, recovery agent scans,
engine queue counting and worker wakeups. Throughput and peak RSS **need run at merge**.

OpenCode v2 integration mutation cases, also **not executed (tests run at merge)**:
drop send correlation at account binding; acknowledge a newer input from an older
run; lose the continuation trigger between admission and delayed run start;
reclassify durable admission as uncertain after an RPC rejection; automatically
resume provider-owned work on restart with auto-continue disabled.

Verifier regression cases, **not executed (tests run at merge)**:

- Mark admitted recovery failed after a rejected RPC: its delayed run must retain
  `limit_resume` and completion must leave no phantom work.
- Ignore provider-owned recovery in resume admission: a second resume must refuse
  without submitting another continuation.
- Send queued or steering follow-ups before the admitted continuation starts:
  both delivery modes must wait behind it.
- Retain ownership after provider exit or crash: native resume must send one fresh
  restart notice, preserve `restart`, and reach done without replaying old input.
- Bypass default exclusion refusal or ignore a real outside writer: migration must
  leave source history, destination files and source binding unchanged.
