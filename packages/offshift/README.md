# Offshift

`@ace/offshift` owns the local coding workflow record ([ADR 0090](../../docs/adr/0090-native-offshift.md)).
Agents reach it through the `offshift` tool in its own `offshift` family, scoped to the
authenticated caller's thread. Nothing loads it upfront: ace's MCP instructions mention it, and an
agent loads the procedure and the tool with `guide` topic `offshift`. No Python installation, control-panel process or user-installed skill is
required.

The agent does the work with ace's other tools and its installed provider CLI. This package
records the outcome, authorized endpoint, acceptance criteria, phase, blocker and latest evidence.
It does not launch providers, schedule background turns, resolve approvals, publish code or expand
the authority the person granted.

Start a run with `{action: "start", runId, outcome, endpoint, criteria: [{id, description,
requiredKinds: ["automated", "source"], independent?}], roles?}`. Read it with `{action: "get",
runId}`. Every view carries `next`, one sentence naming the step to take now; agents follow it.
`list` returns summaries capped at 128 Unicode characters with `outcomeTruncated`; use `get` for
the full outcome. Every view includes the current host-captured source revision and canonical tree
observation. Advance in order through `plan`, `implement`, `verify`, `review`, `delivery`; earlier
phases can be revisited after findings. Changes after start require `version`; `requestId` is
optional. Retry the identical request after a lost response: without a requestId the receipt is
keyed by a hash of the normalized request and caller, so it still applies once. Reusing an explicit
id for different input is rejected. The replay returns the current view, never an old completion.

Before checking behaviour, keep the revision from `get`. After the check, submit `action:
"evidence"` with `evidence: {criterionId, kind, result, revision, action, artifact, note}`.
`artifact` identifies retained evidence; it is a reference, never an instruction for the daemon to
open a path or run a command. The daemon checks freshness and completeness, not whether an agent's
claim is authentic. A failed observation replaces the earlier pass for that kind. Each entry
stores `by` (thread, provider, model) from the authenticated caller, never from input.

A criterion with `independent: true` counts a pass only from another thread on another provider,
or on a model known to differ from the owner's at start. Until then its kind is pending with
`needs: "independent"`. A delegated descendant records that check on its ancestor's run by
passing `runOwner` (the ancestor's thread id) to `get` and `evidence`, from the owner's checkout;
the daemon checks the ancestry and refuses every other action.

Roles name who does `build`, `judgment`, `review` and `verify` work, each `{provider, model,
effort}`. Set them at start, replace them with `{action: "roles", runId, version, roles}`, or set
the project default with `{action: "roles", scope: "project", roles}`. A run without a role falls
back to the project default. `delegate` tasks with `runRole` take that role's provider, model and
effort (task fields win); a role set nowhere is refused. `resolveRole` and `applyRole` hold the
pure rules; `OffshiftProjectRoles` stores the defaults per workspace, outside transcript purges.

Playbooks are built-in step lists for one kind of work: `fix`, `feature`, `refactor`, `perf`,
`investigate`, `ui` and `land` (`playbooks.ts`, pure data). `{action: "playbooks"}` returns the
catalogue. Start with `playbook` and/or `steps: [{id, title, phase}]`; the run keeps them in phase
order as `todo`, up to 24. Mark one with `{action: "step", runId, version, stepId, state: "done" |
"skipped", note}`; skipping needs the reason in `note`. Advancing out of a phase is refused while
it has steps to do; going back keeps done steps. `next` names the current phase's first step to
do, after a blocker and any check that failed at the current revision. A delivered run with a
delivery step to do is not complete.

When a requirement changes, `{action: "revise", runId, requestId, version, criterion, note}` adds
the criterion or replaces the one with its id, and drops that criterion's evidence. A run holds at
most 64 criteria; revising is refused while it is blocked.

Delivery requires current passing evidence for every required kind. Completion is an observation,
not a stored flag: the phase is delivery, evidence still matches, there is no blocker, and the
whole tree is done. Revival, background work and human waits prevent completion. During the
agent's final tool call, `waiting_on_tree` is expected until the agent itself settles.

Each successful change also publishes a bounded card of the run (`runCard`) as an
`offshift.updated` thread event, so the person sees the latest run in the Summary tab, worded
against the whole tree, with the current phase's steps. The card names its `playbook` and the
view's `next` at that write; cards stored before either existed still read. When a project's
default roles change, the latest card of up to 32 of its threads with an unfinished run is
republished if the roles it uses changed (same version, same revision).

`@ace/projection` reduces a card to a run mark (`runMark`: phase, `open` / `blocked` /
`delivered`, pending count, playbook) that the thread's list entry carries, and decides what a
settled tree's notice says about it (`runNotice`). The finished notice of a done tree names an
open or blocked run ("Run stopped at Verify: <next>") on every settle and a delivered run once
per run write; a live tree never notifies about its run.

`OffshiftJournal` takes the host's synchronous SQLite transaction port and stores runs and request
receipts atomically in the daemon database. Records cascade with the owner thread and are purged
with transcript payloads. It keeps at most 32 runs per thread, 512 changes per run, 64 criteria, 24 steps,
five evidence kinds per criterion and 48 KiB per run. Explicit calls snapshot tracked and
nonignored source with `@ace/git`; the real index is untouched. A workspace Git cannot snapshot
answers `unavailable` instead of recording evidence without a source.
