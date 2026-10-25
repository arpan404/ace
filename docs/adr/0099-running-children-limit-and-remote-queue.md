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
work, "Agents a thread runs at once") is a whole number from 1 to 1000, or `null` for no limit.
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
with its task shown on its thread (`queuedLaunch`), and starts when a thread finishes, when the
limit changes, or on the one-second retry. The queue survives target restarts. The target reports
the child as `queued` with status `waiting on queue`, so the caller's parent shows it waiting,
`agents_status` and `wait` read it as queued like a local child, and the parent never looks done.
The delegate answer carries `queued: true` so the caller shows it queued before its first poll.

**What a remote child counts against.** On the target, a child counts against the calling thread
on the other machine: the paired device, its host and the origin thread. That is the target's
nearest equivalent of a parent; the target's own limit applies, because the person who owns that
machine decides how much runs on it. Children from different calling threads, or different
machines, never share slots.

**Cancel and failure while waiting.** Cancelling a waiting remote child removes it from the queue
and settles it `cancelled` ("Stopped before it started.") without running. A waiting child that
later fails to start for a reason other than a full engine settles `failed` ("It could not be
started.") instead of waiting forever. Both outcomes are kept in `machine_launches` so the caller
reads them on its next poll. The parent's own message to a waiting remote child starts it first,
past the limit, as it does for a local child.

## Consequences

- A person with many children can run them all; one who wants fewer sets a number.
- Children sent to a busy machine wait instead of failing, and the parent sees them waiting.
- Queued local children still keep their own table and journal edges; the remote queue shares the
  queue code and slot rule, not the table, because a remote child has no local parent edge.
