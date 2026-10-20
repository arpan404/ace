---
name: offshift
description: Own a multi-step coding outcome through verified delivery, keeping criteria and evidence in a durable record. Use when the person asks for Offshift or end-to-end execution.
---

# Offshift

`offshift` keeps this thread's record of the outcome: criteria, phase, blocker and evidence bound to the workspace's Git revision. It survives restarts. It records work and never runs it; do the work with your own tools and ace's. If `offshift` is not in your tool list, call `guide` with topic `ace-threads` first.

1. **Start or resume.** Call `context` with `topics: ["recent", "notes", "changes"]`. Then `offshift` `list`, and `get` any run for this assignment: resume from its phase, blocker and pending evidence. For new work, `start` with a `runId`, a `requestId`, the observable `outcome`, the authorized `endpoint` (local changes, an open PR, ...) and `criteria`, each with the evidence kinds it needs: `automated`, `source`, `ui`, `human` or `manual`.
2. **Every change** after `start` takes a fresh `requestId` and the last returned `version`. After a lost response, repeat the identical call. On a version conflict, `get` and reconcile before you retry.
3. **Advance one phase at a time:** `plan`, `implement`, `verify`, `review`, `delivery`, each with a concrete `note`. Go back to an earlier phase to repair. If the requirements change, `revise` the criterion: its old evidence is dropped.
4. **Do the work with the skill that owns it:**
   - parallel parts: guide `plan-and-delegate` (`delegate`, then `wait`);
   - a bug: `investigate-bug`; red tests or CI: `fix-failing-tests`;
   - UI behaviour: `ace-browser` for the check and its evidence;
   - review: `review-changes`; the PR endpoint: `prepare-pr`;
   - a handoff from another provider: `handoff_read`; thread changes: `ace-threads`.
5. **Record evidence.** `get` the run and keep its `revision`, run the real check, then record `evidence` with that revision, the `action` you performed, an `artifact` reference and a short `note`. A failed check replaces an earlier pass. If the source changed during the check, repeat it.
6. **Blockers and decisions.** `block` records what stops you; it does not ask anyone. Ask the person with `ask`, then `resume` with their decision in `note`. When they want to pause or stop, use `thread_control` (`interrupt`), never a record.
7. **Lasting facts** about the project (how to run its tests, a pitfall) go to `note_add`, not the run.
8. **Deliver.** Advance to `delivery` only when every criterion has a current pass. `waiting_on_tree` means a child or this thread is still working or waiting on the person: `wait` for it. The run is `complete` only when the whole tree is done.

Report the outcome, the checks behind it and any gaps. A record is never a running background agent; never describe it as one.
