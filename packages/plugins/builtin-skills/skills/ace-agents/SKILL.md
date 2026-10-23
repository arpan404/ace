---
name: ace-agents
description: Hand work to other agents through ace and collect their results, on this machine or another paired one. Use before delegate, wait or agents_status.
---

# Agents in ace

ace runs child threads on any installed provider (Claude, Codex, OpenCode, Cursor, Pi, ACP). Children appear in the person's sidebar under this thread. Your session facts list the providers you can delegate to and the access modes each allows.

## Start children

For independent or parallel work, prefer `delegate` to your provider's native subagent or Task tool: each child runs as its own thread with its own transcript, and the person can watch and steer it.

Call `delegate` once with `tasks: [{ requestId, task, role }, ...]`, up to 64 tasks:

- **requestId:** any stable id you choose. A retry with the same ids starts nothing new.
- **task:** the whole assignment: goal, files, constraints, the project notes that apply, and how to verify. A child sees none of your conversation.
- **role:** the child's display name in the sidebar. It must be unique among your live children and say what and where (e.g. `Fix-869-worked-for-toast`, never `Implementer`). Generic names and repeats are rejected.
- **Optional per task:** `provider` (default: yours), `model` (an id from `models`; ace picks the account), `effort`, `access` (`inherit` by default, never above yours), `workspace` (this checkout by default, a `new_worktree` from a base branch, or an `existing_worktree`), and `machine` with `project` to run on another machine.

At most a few children run at once per parent; the rest wait queued and start as slots free.

## Collect results

Choose one:

- **Collect now.** Set `waitSeconds` (up to 600) on `delegate`, with `waitFor: "any"` if the first result is enough, or call `wait` with the thread ids. `wait` also works for any thread you can read.
- **Collect later.** End your turn. Settled results arrive as a new turn. Results already read through `wait` don't arrive again.

Handle each wait status:

- `ready`: check each child's result against its task before you use it.
- `needs_you`: a child waits on the person. Tell the person what it asks, and treat it as unfinished.
- `timeout`: the children keep working. Wait again.
- `interrupted`: ace restarted. Wait again.

A failed or cancelled child is not done. `agents_status` gives a compact snapshot of every child and its descendants; `agents_status { threadId }` reads one child, with its result once it has settled. Use `wait` for waiting, never a polling loop.

## Steer children

- `agent_message` sends follow-up work to a child, here or on another machine, or a thread you started. `delivery` is `steer` (default for your children: joins its running turn at the next tool boundary; on Cursor it restarts that turn with the message), `queue` (after its current turn; default for other threads) or `restart` (interrupt and replace queued input). The result's `arrival` says what happened: `starting`, `steering`, `restarting`, `queued` (runs when its turn ends), `held` (waits for a limit, a request to the person or a paused queue) or `delivered`. If a message later fails to reach a child, ace tells you in a notice, and `agents_status` shows it.
- `agent_cancel` stops a child and its descendants. Confirm with `agents_status` or `wait`.
- `question_answer` answers a question a child asked (it shows under `needs_you`). Permission approvals stay with the person.
- `ask`, when offered, asks the person a question and waits for the answer. Delegated children get it.

## Other machines

`machines` lists the person's other paired machines that let agents in, with their projects and providers. Pass `machine` and `project` in a `delegate` task to run it there; that machine applies its own access mode and consent. `wait`, `agents_status` and `agent_cancel` cover children there too.
