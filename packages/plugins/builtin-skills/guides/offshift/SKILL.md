---
name: offshift
description: Own a multi-step coding outcome through verified delivery, keeping criteria and evidence in a durable record. Use when the person asks for Offshift or end-to-end execution.
---

# Offshift

`offshift` keeps this thread's record of the outcome: criteria, phase, blocker, roles and evidence bound to the workspace's Git revision. It survives restarts. It records work and never runs it; do the work with your own tools and ace's. Reading this guide (`guide` with topic `offshift`) loads the `offshift` tool.

**The loop: every result carries `next`, one sentence naming the step to take now. Do it, then call `offshift` again.** Stop only when `next` says the run is done, and report.

1. **Start or resume.** Call `context` with `topics: ["recent", "notes", "changes"]`. Then `offshift` `list`, and `get` any run for this assignment: resume from its `next`. For new work, `start` with a `runId`, the observable `outcome`, the authorized `endpoint` (local changes, an open PR, ...) and `criteria`, each with the evidence kinds it needs: `automated`, `source`, `ui`, `human` or `manual`. Mark a criterion `independent: true` when your own check is not enough: only a pass from another provider or model counts.
2. **Roles** say who does which work: `build` (code), `judgment` (planning, hard design, prose), `review`, `verify`, each `{provider, model, effort}`. Set them at `start` or with `roles` (`runId`, `version`); `scope: "project"` sets the default for runs that leave a role out. Delegate by role with `runRole` on a `delegate` task; fields you set on the task win, and a role set nowhere is refused.
3. **Every change** after `start` takes the last returned `version`. `requestId` is optional: an identical retry after a lost response applies once either way. On a version conflict, `get` and reconcile.
4. **Advance one phase at a time:** `plan`, `implement`, `verify`, `review`, `delivery`, each with a concrete `note`. Go back to repair. If a requirement changes, `revise` the criterion: its old evidence is dropped.
5. **Do the work with the skill that owns it:** parallel parts, guide `plan-and-delegate`; a bug, `investigate-bug`; red tests or CI, `fix-failing-tests`; UI behaviour and its evidence, `ace-browser`; review, `review-changes`; the PR endpoint, `prepare-pr`; a handoff, `handoff_read`; thread changes, `ace-threads`.
6. **Record evidence.** `get` and keep its `revision`, run the real check, then record `evidence` with that revision, the `action` you performed, an `artifact` reference and a short `note`. A failed check replaces an earlier pass. If the source changed, repeat the check. ace records who checked from your session; never claim it in the note.
7. **Independent checks.** Delegate the check with `runRole: "verify"` (or a provider other than yours) in the same checkout, and put your thread id from `next` in the brief as `runOwner`. The child calls `get` and `evidence` with `runOwner`; it can change nothing else.
8. **Blockers.** `block` records what stops you; it asks no one. Ask the person with `ask`, then `resume` with their decision in `note`. To pause or stop, use `thread_control` (`interrupt`). Lasting project facts go to `note_add`.
9. **Deliver** only when nothing is pending. `waiting_on_tree` means a child or this thread still works or waits on the person: `wait` for children; when only your own turn is left, report and end it. The run is `complete` once the whole tree is done.

Report the outcome, the checks behind it and who ran them, and any gaps. A record is never a running background agent; never describe it as one.
