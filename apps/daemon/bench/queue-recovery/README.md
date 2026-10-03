# Queue and recovery measurements

Not executed. The owner requires tests and benchmarks to run at merge.

Definitions: `queue.ts` measures SQLite CAS edits with transactional command receipts
and a fixed 128-message held queue; `context.ts` measures a million pure occupancy
transitions; `persistence.ts` measures SQLite context samples and projected events.
`deltas.ts` measures persisted deltas with 128 large held messages, exercising the
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
