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

  A refusal of one attempt alone (a machine still starting, one that can't be reached) answers
  nothing and the message is sent again. The access and ownership checks are no longer such
  refusals: see _A message the target refuses before it reaches the thread_ below. Retries wait one second after an attempt, doubling to at most a
  minute (saved, from the injected clock); at most 16 run at once, and 4 to any one machine;
  messages being sent and machines at their cap are left out before choosing, so an unreachable
  or slow machine never holds back a message to another. A take or a final refusal drops the record in the same
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
  turn number), so every eligible child is checked in turn however many there are. A child
  found running again reopens: the parent's row shows it running and the parent waits until it
  settles again. One that ran and settled with a different result hands the parent that result;
  changes that leave the outcome and result alone (a title, a pin) are ignored. Work started
  there more than 24 hours after the child settled is not noticed; the parent was told its result
  long before.

**Every unsettled child is read in turn.** Each poll reads unsettled children with at most 16
status calls of 16 children each, and at most 64 children from any one machine. Each machine
with unsettled children has a row in `machine_child_cursors`: the poll turn it was last served
in, and the id of the last child read there. A poll serves the machines served longest ago,
however many children the others have or keep gaining, so a machine left out of one poll goes
first in the next and every machine is served within a bounded number of polls. On each machine
the poll reads up to its share in id order from where it stopped, wrapping to the first child
after the last, so every child there comes round within a bounded number of serves. The work per
poll is bounded by the call budget, never by how many children are active: up to 16 machine
rows, a few pages from a partial index of unsettled children, and one write per machine served.
A machine whose page comes back empty leaves the rotation; a new or reopened child brings it
back. So however many children wait, and however many stay working or unreachable, a later
child's result always reaches its parent. Listing children (`agents_status`) and a cascading Stop
read by parent through an index on the parent thread: the parent and every thread delegated
below it here. A Stop reaches every unsettled remote child of the stopped tree, and the listing
counts every child, with no cap.

**A message the target refuses before it reaches the thread.** The access check (agents turned
off, or only allowed to read), the ownership check, and a deleted thread refuse a message before
it reaches its thread. The target saves that refusal under the request's key
(`machine_message_rejections`) and answers `final`. Before admitting any copy of a message it
checks that table first, so a request once refused this way never runs, not even a copy still
on its way that arrives after agents are allowed again. Node runs the check and the admission in
one synchronous step after the access check resolves, so a copy is either admitted before the
refusal is saved or refused after it, never both. If a copy already reached the thread (its
receipt exists), the refusal is not saved and the answer only says so, still `final`: that
copy's fate stands, and the caller treats it as work that may have run. Deleting a thread is
permanent (`deletedAt` is never cleared), and the deleted-thread check also saves a refusal, so a
message to a deleted thread is refused for good, and the thread's status reads cancelled with
"Its thread was deleted on that machine." as its result.

A refusal is kept while its device can still be admitted, and no longer. Revocation and expiry
of a device are permanent: a revoked or expired device never authenticates again. Revoking a
device deletes its refusals in the same write (a trigger on `devices`), and the target deletes
the refusals of devices whose access ran out when it starts. Admission checks that the device is
still active in the same synchronous step as the refusal lookup, so a copy that authenticated
before the revocation and was still waiting in the access check is refused too. Without that
check the deleted refusal would let it run; with it, no copy from that device can ever be
admitted again, so its refusals are not needed. A time limit alone would be unsafe for the same
reason. Refusals of a device still paired stay as long as the pairing does; they are small, and
one exists only for a message the target actually refused.

These guarantees, and those of the command receipts, hold within the target's retained history.
Resetting the target's database, or restoring an older copy, erases refusals and receipts, so a
delayed copy that lands afterwards is judged afresh (a deleted thread that no longer exists still
refuses it, as `not_found`, but a restored thread could take it). ace does not fence database
incarnations; this is a known limit.

The caller treats a final refusal with one of those codes (`machine_opted_out`,
`machine_forbidden`, `not_found`) as proof that nothing ran or ever will: the message is
answered without reopening the child. A retry rejected this way also tells the parent ("Your
message was not taken there and will not run"), as the parent was only told its call was lost.
This is safe under the first priority: the child is never read settled while a copy might still
run, because no copy of a rejected request can ever be admitted. The cost is that a parent
repeating the same request id after the person allows agents again gets the same refusal; a new
message gets a new request id.

**A child whose pairing is gone is lost, never settled on its own.** Each child records the
paired device it was delegated through (`device_id`). Once that pairing is gone here (removed,
or the machine linked again as a new device), nothing on this machine can read, message or stop
the child, yet its work there may still be running. It stays unsettled, marked lost in the
ledger (`lost_at`), and its parent stays unresolved and asks the person, through the same means
a remote child's own requests use: an approval in the parent thread (the composer strip),
"Lost: Studio is no longer paired; its work there may still be running." The child's row reads
Needs you (its launch row's status is `needs_you`, which the shared row logic shows on web and
iOS), `agents_status` counts it as needing the person, and `wait` returns `needs_you`. The
approval names the child in its raw payload (`ace.machine.lost`), so the web row offers the same
answer as a text button under that sentence. If the approval closes while the child is still
lost (its parent's session ended, a restart), the next poll opens it again.

Two things resolve it:

- _The pairing comes back as the same device_ (the saved machine restored, or its address
  updated with the same device credentials). The approval closes, the child is tracked again,
  and the poll reads it: its result, or its work still running, reaches the parent as usual.
  Linking the machine again as a new device does not resume it: the target gives each thread
  only to the device that delegated it, so the new device can't read it, and it stays lost
  until the person stops tracking it.
- _The person stops tracking it_ ("Stop tracking; its work on Studio may still be running").
  Only then does it settle, cancelled, with the result "Stopped tracking: Studio is no longer
  paired with this machine, so this child can't report back. Its work there may still be
  running; check on Studio." Its unanswered messages are dropped and it leaves the re-check
  window; the parent gets that result. Nothing that arrives late reopens it: a message's reply
  applies only if its record still exists, in the same transaction, status and re-check replies
  never apply to a lost or stopped child, and a new message to it is refused.

This keeps the first priority: nothing reads done while part of the tree might still be
working, unless the person, told plainly that it may still be running, chooses to stop
tracking it. Children from before the device was recorded fall back to the machine's name.
Pairings that can't be read are never taken as gone, or as back. A target that no longer
accepts the pairing (`unauthorized`, the device revoked there) is not lost: the caller can't
tell that from here with certainty, so the child stays working and says so, and removing the
pairing here makes it lost.

**Waiting stays visible.** A child whose machine can't be read, or won't take its message yet,
stays working and says why in its step, which `agents_status` and `wait` show: "Studio: agents
from other machines are off there", "Studio: agents from here may only read there", "Studio: it
no longer accepts this pairing", "Studio: unreachable; retrying", or "Message waits on Studio:
…" for a message not taken yet. It is never marked done. The reasons are kept in memory and
return on the next poll after a restart. A machine with agents turned off is a step, not a
`needs_you` state: that state carries requests the parent can answer, and there is none here.

## Consequences

- A person with many children can run them all; one who wants fewer sets a number.
- Children sent to a busy machine wait instead of failing, and the parent sees them waiting.
- A machine that turns agents off or deletes a child's thread no longer leaves the parent
  waiting on a message forever; one turned off leaves the child visibly waiting.
- Removing a paired machine leaves its children lost and asking the person, until the pairing
  returns or the person stops tracking them.
- Queued local children still keep their own table and journal edges; the remote queue shares the
  queue code and slot rule, not the table, because a remote child has no local parent edge.
