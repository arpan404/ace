---
name: offshift
description: Own a multi-step coding outcome through verified delivery, keeping steps, criteria and evidence in a durable record. Use when the person asks for Offshift or end-to-end execution.
---

# Offshift

`offshift` is this thread's durable record of one outcome: its steps, criteria, phase, blocker, roles and evidence bound to the workspace's Git revision. ace stores it, checks it and shows it to the person. It records work and never does it: you work with your own tools and ace's. Reading this guide (`guide` with topic `offshift`) loads the tool.

## When to use it

- Use it for a multi-step outcome you are trusted to own: a defect, a feature, a refactor, a measured speed-up, a UI change, an investigation, or landing a PR.
- Skip it for a one-line edit or a quick answer. The record costs calls; spend them where verification matters.

## The loop

**Every result carries `next`: one sentence naming what to do now. Do it, then call `offshift` again.** Stop only when `next` says the run is done, then report.

1. **Resume first.** Call `context` with `topics: ["recent", "notes", "changes"]`, then `offshift` `list`. If a run fits the assignment, `get` it and follow its `next`.
2. **Pick a playbook.** `playbooks` lists them with their steps:
   - `fix`: repair a defect at its root and prove it where it showed.
   - `feature`: add one observable capability and nothing beyond it.
   - `refactor`: change structure while behaviour stays the same.
   - `perf`: make something measurably faster, numbers before and after.
   - `investigate`: answer a question from evidence; no code changes.
   - `ui`: change what people see, checked in the running app.
   - `land`: bring an open PR to merge-ready.

   If none fits, write `steps` yourself (`{id, title, phase}`, up to 24 in all). They can also extend a playbook.

3. **Start.** `start` with a `runId`, the observable `outcome`, the authorized `endpoint` (local changes, an open PR, ...), `playbook` and/or `steps`, and `criteria`. Each criterion names the evidence kinds it needs (`automated`, `source`, `ui`, `human`, `manual`). Set `independent: true` when your own check is not enough.
4. **Work the steps.** After each one, call `step` with its `stepId` and `state`: `done` with a `note` of what you observed, or `skipped` with the reason in `note`. ace refuses to leave a phase while its steps are still to do.
5. **Advance one phase at a time:** `plan`, `implement`, `verify`, `review`, `delivery`, each with a concrete `note`. Go back to repair; done steps stay done. If a requirement changes, `revise` its criterion: the old evidence is dropped.
6. **Record evidence.** `get` and keep its `revision`, run the real check, then send `evidence` with that revision, the `action` you performed, an `artifact` reference and a short `note`. A failed check replaces an earlier pass. If the source changed, repeat the check.
7. **Deliver** only when nothing is pending. `waiting_on_tree` means a child or this turn still works or waits on the person: `wait` for children; when only your turn is left, report and end it.

Every change after `start` takes the last returned `version`; on a conflict, `get` and reconcile. `requestId` is optional: an identical retry applies once either way.

## Quality bar

- Name the data shape and the observable behaviour before writing code.
- Make the smallest change that solves it. Delete before you add.
- Fix the root cause, not the symptom where it surfaced.
- Tests assert what a user or caller observes, and fail when that breaks.
- Prove it on the real surface (the running app, the real CLI, the real API), not a proxy.
- A consequential diff gets an independent check: delegate with `runRole` `review` or `verify` on another provider.
- No comments that narrate the change; comments explain why the code is the way it is.
- Every claim in the final report carries its evidence, or is labelled unverified.
- Never ask the person what an experiment can answer. Ask (with `ask`) only for product or preference calls.

## Roles and independent checks

Roles say who does which work: `build` (code), `judgment` (planning, hard design, prose), `review` and `verify`, each `{provider, model, effort}`. Set them at `start` or with `roles` (`runId`, `version`); `scope: "project"` sets the default for runs that leave a role out. Delegate by role with `runRole` on a `delegate` task; fields you set on the task win.

For an independent criterion, delegate the check in the same checkout and put your thread id from `next` in the brief as `runOwner`. The child calls `get` and `evidence` with `runOwner`; it can change nothing else. ace records who checked from the session, never from the note.

## Blockers

`block` records what stops you; it asks no one. Ask with `ask`, then `resume` with the decision in `note`. To pause or stop, use `thread_control`. Lasting project facts go to `note_add`.

## Use the skill that owns the work

- Parallel parts: guide `plan-and-delegate`.
- A bug or unexpected behaviour: `investigate-bug`.
- Red tests or CI: `fix-failing-tests`.
- UI behaviour and its evidence: `ace-browser`.
- Reviewing a diff: `review-changes`.
- Opening or updating the PR: `prepare-pr`.
- A handoff or another thread: `handoff_read`, `ace-threads`.

Report the outcome, the checks behind it and who ran them, and any gaps. A record is never a running background agent; never describe it as one.
