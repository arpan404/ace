# 0099: The running-children limit is a setting, and children sent to another machine queue there

Date: 2026-10-25. Status: accepted. Amends [0078](0078-multi-device-mcp.md) (a machine refused a
delegated task it could not start at once) and the fixed limit [0098](0098-resume-after-restart.md)
refers to as the parent's concurrency slots.

## Context

A parent ran at most four delegated children at once. The number was a hard-coded default in
`DelegationPolicy`; only tests and benchmarks could change it. Further children waited queued,
which is right, but the person could neither raise nor remove the limit.

Children sent to another paired machine skipped the queue entirely. The target ran
`thread.create` with the task and, when its engine had no free slot, refused the child ("This
machine could not start it"). On the caller's own machine the same full engine made a child wait
and retry.

## Decision

**A setting, no limit by default.** `agents.maxRunningChildren` (Settings → Agents → While agents
work, "Agents a thread runs at once") is a whole number from 1 to 64 (the engine's own thread limit), or `null` for no limit.
`null` is the default. The daemon reads it at each launch and on every change: raising or
clearing it starts waiting children at once, lowering it only holds back later starts and never
stops a running child. `DelegationPolicy.maxConcurrent` stays for tests and benchmarks; when set
it wins over the setting. No limit never means failing: a full engine still makes children wait
(`engineFull`), as before.

**Children from another machine use the same queue.** The target now prepares the thread
(`thread.prepare`), so what can never run (no such project, provider or model, a disabled
provider) is still refused at once and leaves nothing behind. It then sends the task through the
same pieces local delegations use (`startOrQueue`, `drainLaunches` and `LaunchQueue` in
`agent-control/launch-queue.ts`), with its own durable table `machine_launch_queue`. A child that
can't start yet, because the engine is full or the limit is reached, waits there in arrival order
with its task shown on its thread (`queuedLaunch`). The queue survives target restarts.

Each remote child's row in `machine_child_launches` records its calling thread and whether it
holds a slot: started, not finished, and not held for the person (a queue a Stop or restart left
waiting runs nothing, so it gives its slot away, as a local child does). The flag changes only
when that child's status changes, so the count is one indexed query. The queue drains when one of
these children gives its slot back or the limit changes. Only when a start hit a full engine does
it also retry as any thread goes idle, and on a one-second timer. The target reports
the child as `queued` with status `waiting on queue`, so the caller's parent shows it waiting,
`agents_status` and `wait` read it as queued like a local child, and the parent never looks done.
The delegate answer carries `queued: true` so the caller shows it queued before its first poll.

**What a remote child counts against.** On the target, a child counts against the calling thread
on the other machine: the paired device, its host and the origin thread. That is the target's
nearest equivalent of a parent; the target's own limit applies, because the person who owns that
machine decides how much runs on it. Children from different calling threads, or different
machines, never share slots.

**Cancel and failure while waiting.** Every way a waiting remote child can end removes it from
the queue and settles it `cancelled` ("Stopped before it started.") without running, in the
transaction that ends it: a cancel from the calling machine (including a Stop of the parent
there, which cascades to it), a Stop on the target (through the delegation owner's Stop
lifecycle), and Settle, archive or delete on the target (through a store write hook that sees
the `settledAt`, `archivedAt` or `deletedAt` the ending writes). A launch also never starts once
its thread is stopped, settled, archived or deleted. A
waiting child that later fails to start for a reason other than a full engine leaves the queue and
settles `failed` ("It could not be started.") in one transaction instead of waiting forever. Both
outcomes are kept in `machine_child_launches` so the caller reads them on its next poll. New work
for such a child (the parent's message, or a run the person starts there) clears the old outcome,
so it reads working again. The parent's own message to a waiting remote child starts it first,
past the limit, as it does for a local child.

**A settled remote child that runs again.** New work can reopen a child the caller already saw
settle, and the caller must notice so the parent never reads done while it runs.

- _Work the parent sends._ Before the message leaves, the caller saves the child as reopened
  (the parent's row shows it running again), advances its generation, and keeps the message
  itself with its request id until the target answers for it. While a message is unanswered no
  status reply settles the child, because an idle reply can't prove an earlier request will never
  run (it may still be in the target's access check, or behind a timeout). Each poll sends
  unanswered messages again under the same request id, which the target runs at most once (its
  command receipts), alongside the poll so a slow target never stops the watching. What answers
  for a message:
  - the target took it;
  - the target refused it with `final`: the refusal follows a step recorded under the request id
    (the restart's stop, the send, the queue move, the message's own fate), so every copy, a
    retry or one still on its way, gets the same answer and none runs anew;
  - for the first attempt only, a target never reached or refused at its gate, as no other copy
    exists.

  A refusal of one attempt alone (the access check, a machine still starting) answers nothing
  and the message is sent again. A take or a final refusal drops the record in the same
  transaction that advances the generation (a final refusal may leave the message queued there),
  so a reply read before it can't settle the child once nothing guards it; if that transaction
  fails the record stays. A restart keeps the record, so the restarted caller does the same.

- _Work started on that machine_ (the person there messages the thread). Pairing is one-way:
  the caller holds a device token for the target, the target has no route or credential back
  (ADR 0078), so a push would need a new channel. The caller instead keeps re-checking recently
  settled children with the ordinary `status` call: children settled within the last 24 hours,
  at most 16 per machine per check (one call each), every 10 polls (10 s by default) or on every
  poll once only settled children are watched, as those polls already come at that pace. Every
  machine is asked each time, and on each the children checked longest ago go first (a saved
  turn number), so every eligible child is checked in turn however many there are. Unsettled
  children are all read on every poll, 16 per status call. A child
  found running again reopens: the parent's row shows it running and the parent waits until it
  settles again. One that ran and settled with a different result hands the parent that result;
  changes that leave the outcome and result alone (a title, a pin) are ignored. Work started
  there more than 24 hours after the child settled is not noticed; the parent was told its result
  long before.

## Consequences

- A person with many children can run them all; one who wants fewer sets a number.
- Children sent to a busy machine wait instead of failing, and the parent sees them waiting.
- Queued local children still keep their own table and journal edges; the remote queue shares the
  queue code and slot rule, not the table, because a remote child has no local parent edge.
