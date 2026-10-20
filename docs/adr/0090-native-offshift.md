# 0090: Native Offshift workflow records

Date: 2026-10-16. Updated 2026-10-20 (playbooks and steps; notifications, sidebar, review and arena). Status: accepted.

## Context

Offshift existed as machine-installed instructions with Python record and panel helpers. ace had
no native Offshift package or entry point. The former conductor feature was removed (ADRs 0017
and 0060). Agent execution, delegation ownership, durable delivery, canonical tree status and
automation already have owners. A second provider runner would duplicate them, and ADR 0086 caps
the agent-facing tool surface.

## Decision

Add `@ace/offshift` in erasable TypeScript for Node 24. Its pure transitions own bounded
acceptance criteria, phase changes, blockers, criterion revisions, roles and revision-bound
evidence. A synchronous SQLite journal shares the daemon's transaction boundary, so state and
idempotency receipts commit together. Optimistic versions reject conflicting updates; an
identical retry returns a fresh view without repeating the mutation. `requestId` is optional on
changes: without one, the receipt key is a hash of the normalized request (version included) and
the caller's thread, so a retry after a lost response still applies once, and another thread's
identical request is never mistaken for a replay.

Agents reach it through one control tool, `offshift`, in its own `offshift` family (ADR 0086). Its
`action` is one of `start`, `get`, `list`, `playbooks`, `advance`, `block`, `resume`, `evidence`,
`revise`, `roles` or `step`.
The input is one flat object, with each action's required fields checked before anything runs.
It sits behind the `thread_control` capability, like the other tools that write to the caller's
own thread. The daemon routes the `offshift` agent-control operation through the agent owners
registry (`createAgentOwners`), beside handoffs and automations. Only the calling thread owns its
runs: attribution comes from the authenticated MCP lease, and no input selects a workspace,
provider credential or shell command. Native CLI execution stays with the engine; child work
stays with `DelegationService`.

One input selects a thread, narrowly. `runOwner` lets a delegated descendant `get` an ancestor's
run and record `evidence` on it, and nothing else. It exists because an independent check (below)
has to be recorded by a different model, and copying the result back through the owner would let
the owner write it under its own name. The daemon allows it only when the delegation journal shows
the caller descends from that owner and the caller is not being cancelled; any other thread is
refused as `forbidden`. Evidence binds to the owner's checkout revision. A descendant in a
different checkout (its own worktree) is refused with a hint to report its check instead: the
revision hashes the checkout path and identity, so equal commits in two worktrees are not proven
to be the same source, and we chose not to weaken that boundary.

Each evidence entry stores `by`: the recorder's thread, provider and model, from the
authenticated lease and its thread record (the model as configured or delegated), never from
input. A run stores its owner's provider and model at `start`. A criterion marked `independent`
counts a pass only from another thread whose provider differs from the owner's, or whose model is
known on both sides and differs. An unknown model never counts as different. Until then the view
lists the kind as pending with `needs: "independent"`.

Roles name who does which kind of work: `build`, `judgment`, `review` and `verify`, each an
optional provider, model and effort with `delegate`'s bounds. A run sets them at `start` or
replaces them with `roles`; `roles` with `scope: "project"` replaces the project's defaults,
stored per workspace in `offshift_project_roles`, created by the owner on startup, and kept when
transcripts are purged because it has no thread column. A `delegate` task's `runRole` fills its
provider, model and effort from the caller's most recently updated run not yet in delivery, else
the project default; a provider or model on the task wins (an effort-only role still sets effort).
A role set nowhere is refused with the calls that set it, rather than run on the caller's own
provider, and a role whose choice the catalog or admission refuses is reported with the role
named. Resolution is pure (`resolveRole`, `applyRole`); the daemon applies it before the usual
selection resolution.

Every view carries `next`: one imperative sentence, worked out by a pure function from the view
and the count of unsettled descendants, naming the one step to take now (resolve the blocker,
record a kind for a criterion at the revision, repeat a stale check, ask another model to verify
with the owner's thread id as `runOwner`, advance, wait for children, or report and end the turn).
Refusals name the call that fixes them.

`revise` adds a criterion, or replaces the one with the same id. That criterion's earlier
evidence is dropped, since it checked the old requirement. The 64-criteria bound holds, and
revising is refused while the run is blocked.

Offshift loads only on request. Its procedure is a guide-only topic (`guides/offshift`, outside
the projected `skills/` directory), so no provider receives it as a native skill and nothing
loads it into a session upfront. The always-on MCP instructions name it in one line, so an agent
that owns a multi-step outcome can load it itself with `guide` topic `offshift`. Reading that
guide opens the `offshift` family: core-mode clients then list the tool, static clients reach it
through `tools_call`, and Claude Code and Codex keep it deferred behind their tool search until
used. The guide records; it does not repeat ace's other skills. It sends delegation to
`plan-and-delegate`, review to `review-changes`, the PR endpoint to `prepare-pr`, failures to
`fix-failing-tests` and `investigate-bug`, UI evidence to `ace-browser`, and handoff and thread
changes to `ace-threads`. Durable project facts go to project notes (`note_add`). A blocker is a
record; the person is asked through `ask`. Pause and stop use native thread controls.

The daemon captures evidence identity with the existing Git snapshot code: HEAD, tracked and
nonignored content, and checkout identity. This writes Git objects through a temporary index
but no checkpoint ref or commit. Capture happens only on explicit workflow requests, never on
streaming events. Ignored build products and external environment state remain evidence
annotations. Source changes invalidate earlier passes. When the workspace is not a Git
repository, or Git cannot snapshot it, the call answers `unavailable` with a next step for the
agent rather than failing the tool or omitting the source.

Completion is derived on every read from the delivery phase, current passing evidence for every
criterion, no blocker, and canonical whole-tree done. Native thread status owns agents,
interactions and background work; the existing monitor supplies delegated local and remote
descendants, counting remote children beyond its 64-entry display. A provider turn ending, or a
cancellation being accepted, cannot complete a run. The record survives restarts; it is not a
background scheduler and adds no route, palette entry or runner.

Run and evidence byte caps and per-thread and per-run limits bound reads and receipt growth.
Records cascade on owner-thread deletion and are purged with transcript payloads. Artifact
references stay inert data. Agent-reported evidence proves neither authenticity nor
authorization; `by` proves which session recorded it, not that the check ran. The workflow adds
no permission mode and grants no publication or deployment authority. Project roles are bounded
by construction: four roles of three bounded fields.

## Playbooks and steps

Prompt-only procedures tell a model what good work looks like but cannot tell whether it did it.
Offshift stores the procedure with the run and checks it. A playbook is pure data in
`@ace/offshift`: an id, a one-line purpose and four to eight steps, each with a stable id, a short
imperative title, its phase, and optionally the evidence kinds its criteria usually need. The
built-ins are `fix`, `feature`, `refactor`, `perf`, `investigate`, `ui` and `land`, written for
this project. They encode the quality bar as steps: a fix is reproduced on the surface where it
was reported, traced to the first point that went wrong, covered by a test that fails because of
the defect, changed at the root, and confirmed on the same surface; `investigate` has no implement
steps and delivers a cited answer; `land` drives an open PR through conflicts, review threads and
CI. The read-only `playbooks` action returns the catalogue (ids, purposes, steps) so an agent can
choose without reading code; it needs no run, revision or Git workspace.

`start` takes an optional `playbook` and optional custom `steps` (`{id, title, phase}`). The run
stores the playbook's steps, then the custom ones, in phase order, each `todo`, `done` or
`skipped` with an optional note. A run holds at most 24 steps, titles up to 160 characters and
notes up to 1,024; a reused id or more than 24 steps is refused at start. `step` marks one step
`done` (note: what was observed, recommended) or `skipped` (note: the reason, required). A step of
a later phase is refused until the run reaches it, so the phase stays the honest place in the
procedure. Advancing forward out of a phase is refused while it has `todo` steps, and the hint
names them. Going back to an earlier phase is always allowed and does not reset done steps: the
work was observed once, and repair findings belong in criteria and evidence, which already go
stale when the source changes. A delivered run with a delivery step still to do (the report) is
`active`, not complete.

`next` folds steps into its order: a blocker; then, from verify on, a check that failed at the
current revision (a known defect outranks the procedure); the current phase's first step to do;
other pending evidence (stale, missing, then independent); advancing; and the tree. In plan and
implement, evidence is not yet expected, so `next` names the step or says to advance. A run with
steps names its work in them, so a phase without steps of its own just advances.

## Clients

The person sees the run, not only the agent. Every successful change (start, advance, block,
resume, evidence, revise, roles on a run) appends an `offshift.updated` thread-log event in the same transaction
as the run write; reads, receipt replays and refused requests append nothing. The event carries a
bounded `OffshiftRunCard` of that one run as observed at the write: outcome (512 characters,
with a truncated flag), endpoint, phase, blocker, version, revision, the first 16 criteria with
each required kind's state (pass, fail, stale, missing or not independent) and who recorded it
(provider and model, no ids), the first 16 pending kinds with full counts, the roles in use, and
the current phase's steps with their state and, for a skipped step, its reason clipped to 160
characters. The card carries only the current phase's steps because that is what the person can
act on now; the run's 24-step limit bounds the list. Notes, actions, artifacts and done-step notes
stay in the record. A card stays under 52 KB at the run limits and is usually well under 2 KB.

Thread views and snapshots keep only the most recently updated run's card, so a snapshot stays
bounded however many runs a thread starts; the daemon materializes it beside the queue and it
survives restarts. The card says what the run recorded, but the agent writes it mid-turn, so the
card alone can never mean done. The Summary tab words it against the whole tree with the fixed
status words, and shows the current phase's steps (Done, Skipped with its reason, To do), roles,
independent criteria and who checked each kind: Waiting while a blocker is recorded; otherwise the tree's own state (Working,
Approve, Answer, Failed, Waiting) while anything in it works, waits on the person or is held;
Waiting while a settled tree leaves the run unfinished; Done only for a delivered run with every
kind current and no delivery step to do on a settled tree. A done run leaves the Summary. The
Summary's status line names the playbook first when the run started from one ("Fix · Verify · 3
of 5"); the card carries it as an optional field so cards stored earlier still parse. There is no
route, palette entry or composer strip.

When a project's default roles change, cards that use them would go stale. The same transaction
that writes the defaults republishes the latest card of the workspace's threads whose run is
unfinished and whose roles in use change under the new defaults. The run is untouched: the
version stays, and evidence states stay as of the card's own revision, since republishing does
no Git I/O. The fan-out is capped at the 32 most recently updated unfinished cards in the
workspace; older ones refresh on their run's next write.

## Notifications

The moment the person most needs to hear about is an agent ending its turn with work open. ace
learns that from canonical status, not from a provider turn end: the notification service already
folds `thread.updated` status and raises a finished notice when a thread becomes `done`, and a
thread's status counts its delegated children through their summary agents. The service now also
folds `offshift.updated` into a small per-thread run signal (run id and version, the run mark,
and the blocker or else the card's `next`, clipped to 300 characters).

We fold the run into that finished notice instead of sending a second one, so a settle produces
exactly one notification and the person's existing settings (category toggles, quiet hours,
snooze, presence) apply unchanged. When the done tree's latest run is open, the notice's message
reads "Run stopped at Verify: <next>"; when blocked, "Run blocked at Review: <blocker>"; and it
carries `run: {outcome, phase}` for clients. The wording comes from `runNotice` in
`@ace/projection`, a pure function of the run mark and the tree state that returns nothing unless
the tree is done, so a delivered run is never announced while anything still works and a blocker
recorded mid-turn notifies no one (the agent asks the person with `ask`).

An open or blocked run is named on every settle while it stays open: the tree is done, the work
is not, and an unqualified "Finished" would read as done (priority 1). That is still one notice
per settle; a status that does not change (a rename, a replay) produces none. A delivered run
("Run delivered") is announced once per run write: the service remembers the run version it
announced, and later settles at that version send the ordinary finished notice. The next and the
blocker come from the run record, not the transcript, so they are sent like an agent's own
notice; the card's evidence states are as of its last write, as in the Summary.

## Sidebar

A thread's list entry carries `run`, the mark of its latest run (`runMark` in `@ace/projection`:
phase, `open`, `blocked` or `delivered`, pending count and playbook, no ids). `offshift.updated`
is a sidebar event, so the mark travels on the existing thread-list patches; the daemon keeps it in
the thread row's metadata and drops a mark the schema can no longer read. A run write does not
count as thread activity, so it never reorders the list.

The row shows the mark only when the tree is done and the run is open or blocked: the status word
becomes Waiting (never Done) and line 3 leads with the phase word, after a paused ring in the
waiting colour when a blocker holds it; the full line ("Run stopped at Verify") is the tooltip and
part of the spoken details. A working, waiting or asking tree shows its own status and no mark, so
an agent still at work never reads as needing the person. A delivered run adds nothing.

## Review and arena

The guide adds two short recipes made only of existing tools, so no runner is needed. Independent
review: `delegate` with `runRole` `review` or `verify` in the owner's checkout, a brief with the
criteria, the diff base and the owner's thread as `runOwner`; the child records evidence and
reports findings, and the owner fixes them. Arena, for a design or sizeable artifact where one
attempt could fix the wrong shape: the same task to two or three providers or models, each in its
own `new_worktree`; a judge on another provider compares them against a stated rubric; the owner
picks a base, folds in the best parts by hand and verifies as usual. Attempts in other worktrees
record no evidence, because evidence binds to the owner's checkout. An arena playbook step was left
out: the recipe is a choice made per task, not a step every run of a kind should take.

## Verification

Behaviour coverage uses real SQLite through the public journal: reopening, concurrent versions,
request replay with and without a requestId, failed and stale evidence, criterion revision,
blockers, roles and their project fallback, independent criteria, and live or human-waiting
trees. Pure tests cover starting from a playbook or custom steps, refusing to leave a phase with
steps to do, skipping without a reason, delivery steps holding completion and the card's steps.
`next` is tested across states as a pure function, including its order around steps. Daemon coverage calls `offshift` through a real MCP client, checks
authenticated thread isolation and the real Git revision boundary, and covers the non-Git
`unavailable` answer. A delegated child on another provider records an independent check on its
parent's run and it counts, while the owner's own pass does not; a thread outside the tree is
refused; an agent lists `playbooks`, starts from `fix`, is refused leaving plan until it marks
both steps, and advances; `delegate` with `runRole` starts the child on the run's role or the project default, and
task fields win. It also proves that a change publishes the card to subscribers and
snapshots, that replays and refusals publish nothing, and that the snapshot keeps the card after
the store reopens. The web Summary is tested against the fake daemon for a blocked run, missing
evidence, a delivered run that is not Done while a subagent still works, and the playbook in its
status line. `runMark` and `runNotice` are tested as pure functions across run and tree states;
the notification service is tested with real SQLite for the stopped, blocked and delivered
wording, one notice per settle and the once-per-version delivered notice; a daemon test drives a
real run through two settles and checks the notices and the sidebar mark; and changing project
roles republishes the card to subscribers and the snapshot. The web row is tested for the mark on
a settled thread, its absence on a working tree and on a delivered run.
