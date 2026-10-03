# Durable queue and recovery API

[ADR 0053](adr/0053-queue-and-recovery.md) records ownership and failure semantics.
The daemon engine owns this queue. Provider CLIs receive work only after the engine
claims a message; queue edits and command receipts share one SQLite transaction.

Settings use the existing layered settings API:

| Setting                        | Default  | UI label                                                                 |
| ------------------------------ | -------- | ------------------------------------------------------------------------ |
| `threads.followUpBehavior`     | `queue`  | Follow-up behavior: steer / queue                                        |
| `threads.continueAfterRestart` | `false`  | Continue threads after restarts                                          |
| `threads.limitPolicy`          | `manual` | Usage limit: manual / resume at reset / snooze until reset / migrate now |

An omitted `thread.send.delivery` resolves the server setting at admission. Explicit
`steer` or `queue` overrides it for that message. Clients use
`oppositeFollowUpBehavior(defaultBehavior)` for Cmd/Ctrl+Enter. This branch contains
daemon, protocol and client foundations; it has no desktop, web or mobile composer.

Read the queue with `queue.get` or `Client.queue(threadId)`. Results include revision,
hold reason, reset deadline, total messages and an optional `next` command ID.
`Client.queuePage({threadId, after, expectedRevision, limit})` reads another page.
A stale revision or cursor needs a refresh. Pages contain at most 32 messages and
512 KiB of command bytes, except a single larger entry accepted before this feature.
New admission caps are 256 messages, 64 input parts and 256 KiB per message. Older
stored messages remain readable and removable, rather than breaking startup.

All queue commands include `threadId` and `expectedRevision`:

| Command                          | Additional fields                                             | Effect                                                                      |
| -------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `queue.edit`                     | `messageId`, `input`, optional `context`, optional `delivery` | Replace unclaimed content; omitted context removes mentions and attachments |
| `queue.move`                     | `messageId`, `after` (command ID or null)                     | Move after another queued message, or to the front                          |
| `queue.remove`                   | `messageId`                                                   | Remove a queued or uncertain message                                        |
| `queue.pause`                    | none                                                          | Hold delivery and cancel timed recovery                                     |
| `queue.resume` / `thread.resume` | none                                                          | Continue native interrupted work, then drain queued messages                |
| `thread.limit`                   | `action`, optional `instanceId`                               | Choose one of the limit actions below                                       |

`queue_conflict` means another device or delivery changed the revision. Claimed
messages return `message_already_claimed`. Retry a command with its original ID to
retrieve its receipt. An uncertain message needs review and removal before resume;
it cannot be edited into an implicit resend. A new command is an explicit resend.

`queue.updated` carries revision and hold metadata. Clients fetch changed message
pages on that event. Attachments remain thread-owned blobs, with a durable intent
index preventing removal while queued or unacknowledged. Preparation pins the
provider's input until the owning root run ends or the process stops. Reorders
change at most 256 newly admitted rows; stream deltas never scan message history.

After update, crash or reboot, interrupted work becomes a persisted continuation.
It counts as pending engine work even with no queued messages: the thread remains
`waiting` on `queue` until resumed. A notice and the native continuation describe
known dead shells, monitors and subagents. The resumed run has trigger `restart`.
Auto-continue uses the same path, except that uncertain delivery always needs a
human decision. Providers without native resume refuse continuation and keep the
queue held. Claimed recovery operations interrupted by another restart are not
replayed automatically; the operator can issue a fresh resume command.

Rate-limit facts and structured quota errors derive `limited`; process exit does
not erase that evidence. Human interactions and live agents retain ADR 0004
precedence. Queued messages stay held. `thread.limit.action` supports:

- `resume_now`: continue immediately through native resume.
- `resume_at_reset`: persist an indexed timer using the account's latest blocking
  `resetsAt`, with provider retry timing as a fallback when account timing is absent.
- `snooze_until_reset`: expire into a manual hold, without sending work at reset.
- `migrate_now`: stop the source, migrate via the accounts service, and resume on
  the selected account. Omitting `instanceId` chooses another available account.

A resetless account blocker refuses a timer even when a provider estimates a retry
instant. Capacity refusal keeps the timer pending for a bounded retry. Defaults
reload layered settings when limits arrive. A newer pause, timer choice or limit
fences an in-flight resume. Migration refusal leaves the source binding and queue
intact; ADR 0018's independent writer exclusion is required. No writer lease is
invented from stopping ace's own session.

`context_meter.updated` exposes a replaceable per-agent sample: occupied tokens,
context window, epoch, model and the window source. Thread snapshots persist the
meters; `ThreadReader.context` selects the root and `contextMeter(agentId)` selects
another agent. Subscribe to `context:<agentId>` for changes. Compaction start and
completion, process startup, native session changes and model changes invalidate
old occupancy until a fresh provider sample arrives. Missing data stays null.
Reported windows win over exact model catalog windows. Billing counters are never
summed to estimate context. Codex and Claude now produce explicit occupancy facts;
other adapters can emit `context.sample` or `usage.contextTokens` when their native
contract provides an occupancy measurement. Totals alone leave occupancy unknown.

Tests, mutation cases and benchmark definitions are written but **not executed**
under the owner's merge-time rule. See
[measurement and mutation notes](../apps/daemon/bench/queue-recovery/README.md).
Runtime behaviour and throughput/RSS numbers need run at merge.
