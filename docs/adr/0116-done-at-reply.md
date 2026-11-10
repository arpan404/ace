# 0116: Done at the reply; leftover commands don't hold the thread

Status: accepted. Date: 2026-11-10. Owner decision of 2026-11-10. Amends
[ADR 0109](0109-background-work-left-running.md), decision 1 (what holds after a finished turn)
and decision 2 (provider facts no longer decide the hold).

## Context

ADR 0109 kept a thread waiting after its agent's final reply for as long as any background
command the provider might wake the agent for was still running. Claude Code wakes the agent for
every background command it ends, and agents start many: the build or test they report on, but
also duplicate watchers, `until … sleep` loops, monitors on another task's output, and foreground
commands Claude moved to the background after a timeout.

In practice the hold rarely protected a result. Measured on the owner's machine on 2026-11-10,
a delegated Claude child wrote its full final report at 16:10, then sat "Waiting for background
task" until 16:21 on two leftover watchers and a wait loop it no longer needed; its parent waited
with it. Woken turns that only said a watcher had ended repeated the pattern. Sometimes the wake
does carry the result (a child that ends its turn with "Waiting on the iOS build" writes its real
report after the build ends), and ace can't tell the two apart from provider data.

## Decision

1. **The final reply is the result.** Once the thread's main agent finished its turn on its own
   (no run active, its last run `completed`), the commands and monitors left running (`kind`
   `shell` or `monitor`) no longer hold the thread, whichever agent of the thread started them,
   as long as that agent's own turn also finished. The thread reads done, a delegated child
   settles, and its parent receives the reply at once. `@ace/core` `holdsThread` is still the one
   rule; it no longer reads `wakesAgent` or `listening`.

2. **A later wake is an update.** If the provider wakes the agent when a command ends, that is a
   new turn: the thread works again, the delegation edge revives as it does for any later work,
   and the parent receives the new reply as another result. The person's phone gets "done" at
   the reply and a separate "background done" alert when the command ends.

3. **What still holds after the reply:**
   - work while the main agent still runs, or after a turn that was stopped or failed (as before);
   - a subagent's command while the main agent works on: the main agent may be waiting on it;
   - background subagents (`kind: "subagent"`): agents of the tree still at work;
   - ace's own bookkeeping (`internal`);
   - work the provider takes no new prompt beside, marked `blocksPrompts` by its adapter. Today
     that is an ACP shell that outlived its prompt (ADR 0109 decision 2, "ACP keeps holding"):
     reading done would show a thread that refuses the next message.

4. **Shown, never hidden**, unchanged from ADR 0109 decision 4: released commands stay running
   tasks with Stop, the row reads "Done · still running …" and the composer strip lists them.
   The port probe still runs, for the port the strip names. A parent's queued child results no
   longer wait for commands the parent itself left running (`readyForChildResults`).

5. **Cleanup**, unchanged from ADR 0109 decision 5: a done thread with commands still running
   keeps its provider warm; settling or archiving it releases the provider at once, which ends
   them.

## Consequences

- A parent can receive a reply that says work is still running ("waiting on the build"), then a
  second result when the agent is woken. Agents read results as untrusted context and can wait or
  read the child again.
- `wakesAgent` and `listening` stay on `BackgroundTask` for display and the Codex adapter keeps
  reporting `wakesAgent`; neither changes status any more. `blocksPrompts` is new and additive.
- Lost Codex output (`unseenStart`, omitted history, hydration) no longer keeps a replied thread
  waiting: the shell stays listed as running until Codex confirms its end.
- Archiving a replied thread now ends builds and tests it left running, as it already ended dev
  servers.

Tests: core `background-release` (released after the reply, kept while the main agent works,
subagents, bookkeeping and `blocksPrompts` still hold, restore), `acp-lifecycle` (an ACP shell
still holds), daemon `control.process` (a child's reply reaches its parent while its build runs;
the woken turn arrives as an update), `provider-release.process` (archiving ends what a replied
thread left running), notify `status` (done at the reply, a separate background-done alert).
