# 0153: A remote child that lost contact keeps its parent held

Status: proposed. Date: 2026-11-14. Supersedes the lost-contact part of
[ADR 0052](0052-agent-control.md) ("Stop and proof of life", Rule 2 and the remote-children
paragraph). Follows the unpaired-child handling of
[ADR 0099](0099-running-children-limit-and-remote-queue.md).

## Context

ADR 0052 gave every remote child a lease. A child whose machine had not reported it for
`REMOTE_CHILD_LEASE_MS` (10 min) was lost contact: its parent's hold ended as `unknown`, a wait
read it as `failed`, and it came back if it reported again. The rule was "no proof of life
means not live".

That release had no proof the child stopped. A machine that is still paired but can't be
reached (the network is down, or its daemon isn't answering) is the common case, and its child
is usually still working, or waiting on a person, over there. A parent whose own turn had ended
then read done, its child summary read done, and the desktop counted it as finished, until the
machine answered again. That breaks the first priority in AGENTS.md: never show an agent as
done while any part of its tree is still working or waiting on a human.

A child whose machine was unpaired already had the right shape: it stays lost, its parent asks
the person, and only the person's "stop tracking" settles it.

## Decision

Lost contact is not knowing, and the tree says so.

- The lease running out never ends the parent's hold. `machineChild` no longer has a `lost`
  hold, and no remote child's hold ends `unknown` any more.
- The child is marked silent (`silent_since`: when its first unanswered read went out) and its
  parent opens one approval on the child's summary agent: "Lost contact with ‹machine› since
  ‹time›, so ace can't tell whether ‹role› is still working there." Keeping waiting needs no
  answer; the only option is "Stop tracking; its work on ‹machine› may still be running".
- The parent therefore reads `needs_you`. A wait and `agents_status` read the child as
  `needs_you` with `contact: "lost"` and a step saying how long the machine hasn't answered,
  never `failed`. The desktop's lifetime counts, notifications and the orchestrator follow the
  parent's status, so none of them treat it as finished.
- Polling goes on at the scheduler's backed-off pace (`child-schedule.ts`, bounds unchanged).
  When the child reports again its question closes by itself (expired), the child shows its
  real state, and the hold goes on or ends on that state.
- "Stop tracking" settles it cancelled, saying its work there may still be running, ends the
  hold `stopped` and gives the parent that result, exactly as for an unpaired child. A later
  report never revives it.
- The question is stored as the unpaired child's is (`lost_key`, `lost_ask`). Each poll opens
  it again if it closed (its parent's session ended) and never opens a second one, across
  restarts. A Stop closes it. If the machine is then unpaired, the pairing question replaces it.
- A child still held `unknown` by an older build takes its hold back when the question opens.

Children already settled, and results already delivered, are unaffected; this is only about
children that were working or waiting when contact was lost.

ADR 0052's Rule 2 now reads: every live state has a lease; a lapsed lease is lost contact,
which is not knowing; it keeps holding its parent and asks the person, and proof arriving again
resumes it. Only a Stop or the person's "stop tracking" ends a remote child's hold without its
real end.

## Consequences

- A parent can sit in `needs_you` for as long as a machine is down. That is the honest reading:
  ace does not know whether the work is done, and the person can let it go with one answer.
- A wait on a child that loses contact still returns instead of holding the parent's turn, now
  as `needs_you` rather than `ready`.
- Clients need no change: the question shows on the child's row as any request does, and
  `remoteContactStep` still names lost contact on rows from older daemons.

Tests: `machines/remote-child-lost-contact.process.test.ts` (parent held and asked after the
lease, the question closing when the machine answers, stop tracking, a restart keeping one
question, a wait, a Stop, then unpairing).
