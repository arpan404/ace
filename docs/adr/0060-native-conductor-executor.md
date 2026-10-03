# 0060: Native conductor executor

Date: 2026-10-03. Status: accepted for implementation.

## Context

Deck's durable plan, card and lane reducer exists, but the real daemon has no executor. Its fake client can display runs that the real daemon cannot start. ADR 0004 makes the engine the owner of whole-tree status; ADR 0052 explicitly provides a delegation service for Deck. A second provider runner would lose approvals, queue admission, account selection and recovery.

Rechecked origin/main and open PRs #82 and #83 on 2026-10-03. Main contains two 0056 records and 0057. PR #82 reserves 0058 and 0059, so this ADR uses the next free number, 0060. Its initial 0058 allocation preceded PR #82 and is superseded. The existing 0056 duplicates are retained.

## Decision

Register conductor in the listener phase, requiring engine and agentControl, after accounts, notifications and workspaceActions. Activate execution on listen, after maintenance admission and engine recovery are ready. Injected executors remain supported for embedders.

A run owns a durable integration branch and worktree. The planner produces a schema-validated plan. Each workstream is a Deck card; worker, reviewer and fix/integrator sessions are its lanes. All lanes are real engine threads attached through DelegationService before input is queued. Role artifacts are complete assistant messages containing a single JSON artifact, optionally enclosed in a JSON fence. The host parses them with the conductor Artifact schema, fences them by lane generation and validates worker branch/revision against the assigned worktree. Transcript deltas never become scheduler facts. Completion still requires both the artifact and the engine's whole-thread done status. Missing or malformed artifacts become the existing timed escalation, never fabricated success.

Lane bindings and filesystem preparation identities are durable in the daemon store before external effects. Launch receipts use the conductor effect identity. The effect outbox is acknowledged only after thread admission. Replaying an effect recovers its existing thread and worktree. Completed lane bindings remain readable even when the reducer retires the lane. Descendant delegate_task edges remain ordinary delegation records.

Capacity is the minimum of the run's maxParallel, conductor account reservations and host delegation limits. A lane retains its reservation while any descendant, interaction, background task or queued input is live. Native lane admission uses the same account registry as delegate_task. Managed accounts are selected only from the spec allowlist with matching providers. The explicit local account id is local.<provider>, used only when that provider has no managed accounts. It selects the user's default CLI login, never credentials. Capacity snapshots exclude this run's own reservations and include other live native Deck lanes. Account changes use thread.switch and engine account migration; fixes use the engine's portable handoff history when creating the next delegated lane. Provider/account identity is persisted and exposed with every binding.

Each worker gets a private branch/worktree based on the run integration revision after its dependencies integrate. Reviewers get a separate worktree pinned to the worker's immutable revision. Fix lanes get another private worktree at the previous completion. Planner work also uses a private worktree. Nothing executes in the user's original checkout. GitService owns worktree creation and integration. Local integration merges immutable reviewed commits into the Deck branch, serially, with durable effect receipts. Conflicts return to the existing conflict/fix lifecycle. Verification checks repository integrity and immutable revision identity; the review artifact owns acceptance evidence. PR-only mode publishes the integration branch without force through GitService and creates or finds its exact branch/base PR through WorkspaceForge. Remote lookup reconciles a restart after PR creation before local linking. Each verification requires successful CI at the immutable PR head; pending checks retain the effect for retry. Missing remotes, detached bases and unsupported Forge backends remain recoverable execution errors.

Conductor plan, budget, merge and escalation gates remain durable conductor gates answered with conductor.approve. Provider questions and approvals remain engine interactions answered with interaction.resolve. Both appear under needsUser; provider entries carry their interaction and thread ids. Resolving one never grants authority to answer another. Pausing stops new scheduling and pauses lane queues before interruption. Resuming uses the existing queue/recovery commands. Cancellation records subtree stop intents through DelegationService and interrupts each lane with cascade. Interrupt acceptance does not settle a lane: cancelled is published only after whole-thread terminal observations, including queued and not-yet-launched lanes.

Restart discovers every nonterminal run, including those with no pending effects. After normal engine recovery it rebuilds indexed lane observers, reconciles the current whole-thread status and drains the original outbox. Interrupted in-flight sessions are resumed through the engine's recovery API, respecting human interactions and stop markers. A timer owns artifact/stall deadlines and bounded retries; clocks and timer scheduling are injected. Shutdown detaches observers and timers before closing persistence and leaves durable execution intents available for restart.

## Admission retries and artifact recovery

Keep one durable command attempt per effect and target. Commit its command identity and payload before asynchronous preparation. Replay accepted receipts, and replace only queue-conflict/capacity rejections with a new identity. A switch admission receipt is not execution: reconcile the applied provider/account/model selection and indexed engine intent status. Replace an interrupted, failed switch attempt after engine recovery; retain pending and running attempts. Do not resume migrating lanes on the old selection during startup.

Read complete assistant text through Store source ranges, bounded to twice the UTF-8 envelope budget in UTF-16 storage. The envelope budget is one MiB plus one KiB for the kind/revision wrapper. The plan and review schemas retain their respective compact JSON limits. Lost sources, worktrees or invalid artifacts affect only artifact admission. Whole-thread status and timed missing-artifact escalation still run.

## Client contract

Add startedAt and updatedAt to run views and gatedAt to needsUser entries, with defaults for older stored records. Add bounded delegation records with lane, thread, agent, parent thread/agent, provider/account and generation identities. Include delegate_task descendants and retain completed bindings. The existing conductor.request get/subscribe and conductor.changed messages carry the new view. The client package supplies typed read/watch helpers over ClientApi.request and ClientApi.onMessage. Reconnect reacquires a fresh snapshot and subscription. Fake mode emits the same timestamps, bindings and changes.

## Verification

Write process tests using scripted adapters and real daemon stores, sockets and temporary Git repositories for completion, human gates, subtree cancellation, restart and capacity. Static review checks effect receipts, account fences and terminal guards. Tests and mutation cases are not executed; tests run at merge. Development checks are typecheck, lint, formatting, file size and generated protocol documentation. No provider CLI prompts or recorder sessions are used.
