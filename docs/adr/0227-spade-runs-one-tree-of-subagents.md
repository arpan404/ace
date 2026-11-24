# 0227: Spade runs one tree of subagents

Status: Proposed. Date: 2026-11-23. Amends
[ADR 0152](0152-spade-helpers.md) (helper launch and prompt),
[ADR 0161](0161-spade-orchestration-trees.md) (worker launch and lifecycle), and
[ADR 0217](0217-spade-runs-each-task-in-its-own-lane.md) (lane tools and storage).
Builds on [ADR 0215](0215-spade-keeps-the-persons-asks.md) and
[Spade's caching rules](../../spade/docs/design.md#caching).

## Context

Spade has four ways to start parallel work. All isolate the work from the caller's conversation,
track some form of parentage, and return an outcome. The worker tree already shows all four,
but their launch, state, and delivery take different paths.

| Today                                              | What the child owns                                                                                                                                                    | How it reports                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `task_start`, `task_message`, `task_stop`, `tasks` | A lane owns a slice of the person's asks, a goal and plan, and a steerable transcript. It shares the bot's workspace and settings. A hidden helper row backs the lane. | Main receives a report and shows the task in its list.                 |
| `helper`                                           | A disposable conversation for part of a reply. It has a restricted profile and currently builds its own prompt and tool list.                                          | The parent reads the final answer as a background job result.          |
| `bot_create` and `worker_*`                        | A named worker bot keeps a workspace, goal, plan, and conversation across assignments.                                                                                 | Its maker receives a report with the result of the goal check.         |
| ace MCP `delegate`                                 | ace owns the thread, provider session, requests, and execution. Spade records its reference and watches it through ace.                                                | The background job reattaches by thread ID and delivers ace's outcome. |

Each path has its own answer to when to admit work, who gets a result, and what to do after a
restart. A launcher that only forwards to the existing tools would leave those answers in four
places. A single lifecycle makes the tree that drives the UI also drive scheduling, Stop, and
delivery.

## Decision

1. **A subagent is a child conversation.** It has a stable ID, parent conversation, launch call,
   brief, resolved model and effort, tool profile, and context of its own. A run has an epoch.
   The parent gets the child's result even if the reply that launched it has closed. The same
   node represents queued and running work. A lane can take another run when the person steers
   it. A helper has one assignment and its transcript and result remain readable after it
   settles. A worker keeps its bot identity, name, workspace, goal, plan, and settings and can
   take further assignments. An ace node points to an ace-owned conversation and uses ace's
   state and controls.
2. **Main delegates explicitly.** It starts lanes for new asks that need sustained work, sends
   changes to the lane that owns the ask, and handles short answers itself. A lane may use
   helpers within its grants. Preserve the current depth limit of 16 and each kind's caller
   restrictions. Only main can open a lane. A helper cannot spawn. Standing bot creation,
   club runs, cross-machine bot messaging, and typed contracts keep their existing entry
   points and authority. A contract call has its own input, output, and effects contract.
3. **Main's automatic move remains a safety net.** At eight steps or two minutes, use the
   existing safe boundary after calls and pending requests have resolved. Move the open work,
   its ask slice, completed call results, movable jobs and wakes, and local child links in one
   write. Keep the move's title and transcript notice. ace delegate and wait jobs, contract
   calls, and jobs already committing their results keep their original delivery owner.
   Record those exceptions and tell main which results to forward. Decide steering, job
   completion, and the move under the existing record and delivery locks so each message and
   result lands once. A moved reply resumes from its next step.
4. **One fold decides whether a node can settle.** Pending person requests in a descendant
   take precedence over working, then sleeping, then idle. Queued or stopping work,
   unresolved jobs, wakes, next steps and goal checks, and active or waiting descendants
   prevent a terminal roll-up. A reply can close while its node is still working. Track
   own and rolled-up state separately. Keep `needs_you` distinct from a verified `done`
   and an unverified `finished`. Check and deliver a report under the record lock against
   the current epoch. A wait or an ace disconnect cannot establish completion.

## Tools

Use the existing `worker` argument for a child ID. Accept existing IDs and aliases (worker
names, lane titles, helper job IDs, ace thread IDs and roles), scoped to the caller's visible
subtree. An ambiguous name returns the matching IDs. The gate enforces who can act on each
node. A call that fails validation returns an error with the reason and has no effect.

| Tool             | Arguments                              | Answer                                                                                                                                                                                                                                                                                                                            |
| ---------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawn`          | `kind`, `brief`, plus the fields below | Accepted immediately after recording the launch. Returns `{worker, kind, name, state, conversation?}`. An ace launch can start as `queued` with a local ID before ace returns a thread ID. A retry of the same stored call returns the same child.                                                                                |
| `worker_message` | `worker`, `text`, `asks?` for a lane   | `{worker, state}` after steering the current run or starting the next. A dormant lane or worker can reopen. An ended helper returns an error. Keep a queued worker's existing message refusal. For ace, acknowledge delivery through ace and surface its errors.                                                                  |
| `worker_status`  | `worker?`                              | `{tree}` for the caller or the selected subtree. Each node has ID, kind, name, own and rolled-up state, needs-you flag, progress, spend, and children. Include conversation and ace thread references when available.                                                                                                             |
| `worker_result`  | `worker`, `epoch?`                     | `{worker, epoch, state, report?, untrusted}`. Read the current run by default and a specific run when named. An active run returns state without a terminal report. Include goal, stored evidence, and verdict where applicable, or the helper's answer or ace's recorded result. Preserve the result tool's untrusted treatment. |
| `worker_stop`    | `worker`, `because?`                   | `{worker, state}` after recording the stop. Return `stopping` while any backend has yet to settle. A model stopping a lane must supply `because`, subject to the existing check for the latest qualifying reply from the person to that lane in this run. A direct Stop from the person uses their existing controls.             |

`spawn.kind` takes `lane`, `helper`, `worker`, or `ace`. For Spade children, `model?`
accepts a routing role or a configured endpoint/model. Default to `task` for a lane (same
model and effort as main unless set), the profile's model or `helper` for a helper, and the
maker's model for a worker. Persist the resolved profile and model choice for the run. Apply
the existing name, brief, goal, and grant validation.

- `lane` requires `title`. `asks?` names main's ledger entries. Omitted, it takes the newest
  eligible open ask. The lane keeps goal checks, overlap notices, and direct messages.
- `helper` accepts `profile?` (default `general`, also `explore` and enabled plugin
  profiles) and `escalate?` (the existing one retry on the bot's model after a failure).
- `worker` requires `name` and `goal` (the old worker's standing task). It accepts
  `tools?`, `connectors?`, and `plugins?` as narrowings. Preserve the default of no copied
  connectors or plugins and the option to detach a worker as a top-level bot.
- `ace` takes `ace`, an object with the existing MCP delegate options for one child,
  including its role and the configured provider/model selection. Spade wraps that object
  in a single-item MCP `tasks` array, sets `task` from `brief`, and assigns the request ID
  and wait duration. ace validates the options, grants, and workspace. Spade's
  model and profile arguments apply only to its own runners.

Keep `wait_for`'s worker condition and resolve it through this tree. Route ace control through
its existing message, status, wait, and cancel calls. Keep the gate's existing risk and review
rules for each mapped operation, including delegate. Giving launch a common name must not
make an outward write count as a read.

## Prompts and authority

Every Spade-run child uses the system prompt and offered tool definitions of the owning bot's
main conversation byte for byte, including order and serialization. For a worker's launch,
that is its maker's bot. For children of an established worker, use that worker's main.
Use the same stored main prefix revision for the launch cohort. A child keeps that revision through restart and adopts
a new main revision at a prompt rebuild boundary such as compaction. The child's first
message carries its role, profile instructions and restrictions, and brief. On a move, keep
this initial context ahead of the carried work. Keep trusted words from the person and a
tainted bot brief separately attributed even when both are part of the initial assignment.
ace-owned threads apply their provider and prompt rules in ace.

Use a provider cache key derived from the owning bot's key and stable across children in the
same cache scope. Group first requests by shared prefix revision and compatible provider,
account, and model. Start one request, then release the other first requests when the lead
has written the cache or its first response completes where write confirmation is unavailable.
Use a bounded wait and elect another lead on failure where possible. Keep admission and Stop
responsive during this wait. A cache miss, a different model, or an endpoint without cache
support can reduce savings. Each call still records its actual read, write, input and output
tokens and cost.

The offered schemas give no authority. Enforce the profile, current grants, and inherited
ceilings at call time, including inline harness calls, deferred discovery and dispatch, and
native tool search where supported. Apply the same review, sandbox, credentials, and access
rules as today. Preserve the helper's bans on direct questions, memory writes, background
tools and further spawning. A worker's grants remain bounded by its maker while attached.
Rule text copied from main cannot confer access to a plugin, connector, or secret.

Record taint when creating, moving, or messaging a child. Preserve the person's words
verbatim as theirs. Bot-written context carries its original provenance and taint, as do
child outputs, errors, and ace results. Receiving a result runs the same trust fold as reading
any other untrusted result. A claimed result stays distinct from Spade's goal check and its
own status text.

## Events, slots, and recovery

Extend the existing worker tree events with a common contract:

- The parent stores `worker_started {worker, kind, call, conversation?, name, queued, asks?}`
  and the local child stores `worker_of {worker, parent_conversation, call, kind, profile,
model, prefix_revision, untrusted}`. Persist the held assignment and owner in that same
  transaction. Use the stored conversation, reply, and call identity for launch idempotency.
  Link the ace thread ID to its local node once ace answers. Use the same ace request key
  when recovering an uncertain launch.
- A child run uses the existing reply events for its epoch. Extend `worker_reported` across
  kinds with `epoch`, `state`, `summary`, optional `words` or `error`, `untrusted`,
  and a result reference. Terminal delivery is once per child and run. A needs-you report
  refers to the request that caused it. Commit result delivery, any job completion required
  by a legacy launch, and the parent's wake decision together. Stopped results are quiet
  except for an explicit waiter. Discard a terminal observation if a newer run started
  before it could be committed.
- Keep `reply_moved` for continuation handoff. Generalize lane routing and request metadata
  to a child reference with run and call IDs. Store a routed message and its ledger transfer
  together. Only the owning lane counts those asks for its stop check. Helper briefs carry
  assignments without owning any of the person's asks. Standing instructions and the lane's
  ask slice survive compaction and restart. A reply to a lane's report or one of its routed
  messages still reaches that lane with no main model call.
- Use one routing path for mirrored requests. Store the child request and its root copy,
  and later the answer and closure of all copies, in paired writes. Use child, epoch, and
  call to distinguish copies. Preserve where an “always” approval applies. Reconcile stale
  copies on open and close only requests belonging to the ending run. Deferred lane cards
  remain answerable after a normal end and close on Stop. ace requests keep their ace path.
- One scheduler applies the existing slot policies. Keep lane and helper limits at 16 per bot
  by default (`SPADE_TASKS_AT_ONCE`, `SPADE_HELPERS_AT_ONCE`), worker limits at 32 per maker
  (`SPADE_WORKERS_AT_ONCE`), and ace admission in ace. Admit oldest eligible work in each
  queue. Preserve tool concurrency and pause/update behavior. Record stop intent under the
  admission lock before releasing slots, mark queued descendants stopped, and cancel running
  descendants, jobs and wakes. Retry ace cancel after a disconnect or restart. A stopped
  subtree cannot admit or resume work from the stopped runs.
- Keep indexed live nodes, queued launches, pending reports, and outstanding request copies.
  Reconcile those indexes at startup and fold new events as they arrive. Resume local work
  from stored events with the existing interrupted-call recovery rules. Reattach ace waits
  to the same threads across MCP timeouts and outages. Keep uncertainty visible until ace
  supplies state. Preserve normal worker detach/delete semantics. Record own and subtree
  spend without counting a delivered result twice. Keep role-level spend and show unknown
  ace costs as unknown. Spend never gates admission.

## Forward migration and removals

Add the common node projection and a versioned reader for historical events. Resolve lanes
from their hidden helper rows and lane links, helpers from their job and conversation rows,
workers from their bot IDs and worker links, and ace children from their recorded thread
references. Preserve old IDs as aliases, including IDs embedded in stored calls and request
cards. Keep each conversation, historical event, call result, workspace, and spend entry.
Recover queued briefs, ownership of asks, active epochs, mirrored request IDs, report delivery
markers, and stop intents before admitting recovered work. A result already delivered by a
legacy path counts as delivered by the common path.

Migrate live records through their indexes and existing link readers. Additive schema changes
must keep database open bounded under [ADR 0170](0170-daemon-never-blocks-on-history-sized-work.md).
Read ended records on demand or backfill in bounded, resumable batches. Make migration
idempotent and update both the node and its recovery markers transactionally. Preserve the
saved prompt and call interpretation for legacy in-flight runs through their current epoch.
Use the shared prefix for new runs and launches. Carry legacy pending calls through compatible
handlers keyed to their stored call identity, including a `bot_create` that already created
a worker or a helper whose result was already committed.

Once callers switch, remove `task_start`, `task_message`, `task_stop`, `tasks`, `helper`,
and the worker form of `bot_create` from the model's tool list. Keep `bot_create` for standing
bots. Replace Spade's offered ace `delegate` with `spawn(kind=ace)` and keep the MCP tool
behind the adapter, including recovery of earlier delegate and wait jobs. Retire the separate
launchers, schedulers, and report writers after the shared path handles their live records.
Keep historical decoders and replay handlers for stored conversations.

## UI

Use the existing tree endpoint for one task tree under the main conversation. Keep the tasks
pill, desktop/web popover, and iPhone sheet. Show needs-you, running, recently finished, and
queued work in the existing order, with nesting under the conversation that started it.
Page finished nodes. Lanes show the asks they own and open their transcript and composer.
Helpers show the brief, status, and result. Workers open their persistent bot conversation.
ace rows open their ace thread. Each row can expose Stop where authorized. Status, progress,
and spend come from the same projection as `worker_status` and the bot's roster roll-up.
Root request strips identify the child and route answers to the correct run. Serve existing
task and helper endpoints as projections until their clients move to the tree.

## Build phases

1. **Read the tree.** Add the common projection, identity aliases, and historical readers.
   Compare the old and new views on stored active and ended examples of all four kinds.
2. **Unify lifecycle for local children.** Route existing entry points through shared
   admission, state, result delivery, and Stop. Test queue order, request mirroring, late
   answers, and crash recovery between launch, settle, report, and cancellation.
3. **Switch local launch and prompts.** Add `spawn` and extend controls to lanes. Move main's
   fallback onto the same lifecycle. Test ask transfers during concurrent steering and
   completion, gate denial through each dispatch path, exact prefix bytes, cache staggering,
   and recovery with a legacy in-flight prompt.
4. **Switch ace launch.** Add the ace adapter to `spawn` and share controls and reporting.
   Test daemon disconnect, uncertain launch, reattachment, needs-you roll-up, and Stop
   across an ace outage using a scripted MCP peer.
5. **Switch the clients and retire old paths.** Verify the same tree drives the pill, task
   rows, request routing, and Stop. Remove old advertised verbs and duplicate runtime paths
   after replay and forward-migration fixtures pass. Check that summed spend agrees with
   the ledger and a large history adds no startup scan.

## Open questions

- Should the tasks pill count every live child or count only lanes while the popover shows
  the whole tree?
- Should the first release keep the current separate slot settings indefinitely, or follow
  up with a shared per-bot ceiling after measuring typical concurrent work?
