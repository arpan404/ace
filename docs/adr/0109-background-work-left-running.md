# 0109: Background work left running after a finished turn

Status: accepted. Date: 2026-11-01. Amends [ADR 0004](0004-canonical-agent-model.md) ("a
thread is done only when … no background task is live") and refines thread settlement for
[ADR 0052](0052-agent-control.md) (delegation).

## Context

Delegated children often start a dev server in the background (`bun run dev &`, Claude Code's
background Bash, a Codex terminal left open), write their final reply, and stop. The child kept
reading "Waiting" on its background shell and its delegation never settled, so the parent sat on
"Waiting on N agents" for work that would never report back.

The waiting rule exists for a reason: some background work is pending work. A test run or build
the agent will read keeps the thread open, and Claude Code wakes the agent when such a task ends.
A server left running for the person is not pending work: nothing will come back for it.

What each provider reports when a turn ends with a background command still running:

| Provider                                   | Wakes the agent when it ends?                                                                                                                                                                                                                                                                                                                                                                              | Says it is a service? |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Claude Code                                | **Yes.** The call's result says "You will be notified when it completes" and the end arrives as `task_notification`, which starts a new turn (`fixtures/claude/2.1.286/background-shell.jsonl`, seq 19 and 32; [research](../research/providers/claude-code.md) §5). Background commands are capped (30 min default, 2 h max) and the agent is re-invoked at the cap (Bash tool description, CLI 2.1.312). | No                    |
| Codex                                      | **No.** The terminal's `item/completed` arrives 11 s after `turn/completed` with the old turn id; no turn and no status change follow ([fixtures/codex.md](../research/fixtures/codex.md) question 1; `fixtures/codex/0.159.1/background-shell.jsonl`, t=12290 → 23076 → nothing until 53251).                                                                                                             | No                    |
| ACP agents (Antigravity, Gemini, registry) | **No.** An ACP agent only works inside a client's `session/prompt`; it has no way to start a turn itself. Antigravity keeps `execute` calls open past `PromptResponse` ([research](../research/providers/antigravity.md), background work).                                                                                                                                                                | No                    |
| Cursor SDK                                 | Not applicable: tools that outlive the turn are already ended as `unknown` at once and never held the thread.                                                                                                                                                                                                                                                                                              | No                    |
| OpenCode                                   | **Unrecorded** ([research](../research/providers/README.md), open question 3).                                                                                                                                                                                                                                                                                                                             | No                    |
| Pi                                         | Unrecorded: a tool with no terminal result after `agent_settled` is lost evidence, not a known service.                                                                                                                                                                                                                                                                                                    | No                    |

No provider marks a command as a long-lived service. The host can see it: a process listening on
a TCP port.

## Decision

1. **The rule, one pure function** (`@ace/core` `holdsThread`). Live background work holds its
   thread open while its agent works, and after a turn that was stopped or failed. Once the
   agent's turn **finished on its own** (no run active, last run `completed`), work holds only
   while the agent may still come back for it. Either fact releases it:
   - `wakesAgent: false`: the provider never resumes the agent when it ends (a provider fact);
   - `listening`: its processes listen on a port (a host fact).

   Work the agent's provider will wake it for, and is not a service, keeps the thread waiting
   exactly as before ("parent waits for a child's background task after its foreground turn
   ends" still holds). Lost work (`unknown` awaiting proof) keeps its hold.

2. **Provider facts.** The Codex adapter marks terminals still open at `turn/completed` (and
   output for them after it, and terminals recovered on hydration) `wakesAgent: false`; the ACP
   adapter marks shells that survive `PromptResponse` the same. Claude, OpenCode and Pi report
   nothing new: their work keeps holding unless it listens on a port.

3. **Host fact: the port probe** (`apps/daemon/src/background-services/`). Claude names each
   background command's output file in the call's result (no structured field carries it), kept
   as `BackgroundTask.outputPath`. The processes holding that file open (the shell and everything
   that inherited its output) and their descendants are the command's; a TCP listener among them
   makes it a service. The probe uses the listener and process tables `@ace/preview` already reads
   (lsof on macOS, `/proc` on Linux; other platforms find nothing and keep holding). It only looks
   at shells with an output file whose provider may wake the agent, and only once their agent's
   turn finished: 2, 4, 8, 15, 30 s after a change, then once a minute. It reports the core fact
   `background.listening {task, ports}`; an empty list removes `listening`, so a server that
   stops listening holds again.

4. **Shown, never hidden.** Released work stays a running `BackgroundTask` with its Stop. The
   thread reads Done; its row says "Done · still running `bun run dev`" (`left-running` live
   fact, from `live.watching`), and the composer strip shows "Running `bun run dev` · :5173" with
   Stop, the strip a stopped turn already had.

5. **One owner for cleanup.** Released work lives in the provider's process. A done thread with
   work still running no longer starts the idle window, so the server isn't killed five minutes
   after the reply; settling or archiving the thread releases the provider at once, as before,
   which ends its process group. A wake the provider does send later (a Claude server crashing or
   reaching its cap) starts a new turn, and the delegation edge revives as it does for any later
   work.

6. **Delegation settles on thread status**, unchanged: a child whose only live work was released
   reads `done`, so its edge settles and the parent receives the result.

## Consequences

- Priority 1 stands: "done" still means no agent works, nothing waits on the person, and nothing
  will come back. A released command is a fact on a finished thread, not work in its tree.
- `BackgroundTask` gains optional `wakesAgent: false` and `listening: number[]`; the core fact
  `background.started` gains `wakesAgent`, and `background.listening` is new. All additive.
- The Codex `background-shell` expectation now reads done at the turn's end.
- Automation runs read the same rule for open work (`automation-run-facts.ts`).
- OpenCode and Pi keep holding until their wake behaviour is recorded; recording it is the
  follow-up that would let their adapters report `wakesAgent`.
- Windows has no probe yet: Claude dev servers there keep the thread waiting.

Tests: core `background-release` (released by each fact, a woken test run waits, a stopped turn
waits, pending work elsewhere wins, restore), daemon `port-watcher` and `probe.process` (a real
server found through its output file, not its neighbour), `control.process` (a delegated child
with a dev server settles and the parent gets its result, the server still listed),
`provider-release.process` (warm while it runs, released on settle), Claude
`background-output`, ui-core `live-status`.
