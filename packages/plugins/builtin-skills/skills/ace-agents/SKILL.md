---
name: ace-agents
description: Hand work to other agents through ace and collect their results, on this machine or another paired one. Use before delegate_task, ace_wait or ace_device_delegate.
---

# Agents in ace

ace runs child threads on any installed provider (Claude, Codex, OpenCode, Cursor, Pi, ACP). Children appear in the person's sidebar under this thread. Your session facts list the providers you can delegate to and the access modes each allows.

## Start children

Call `delegate_task` once:

- **One task:** `{ requestId, task, role, provider }`.
- **Several:** `{ tasks: [{ requestId, task, role, provider }, ...] }`, up to 8.
- **Optional per task:** `model`, `accountId` and `effort` (`ace_agents_catalog` lists the choices); `access` (`inherit` by default, never above yours); `workspace` (`project`, a new worktree or an existing one).
- **requestId:** any stable id you choose. A retry with the same ids starts nothing new.
- **role:** the child's display name in the sidebar. It must be unique among your live children and descriptive of the work (e.g. `Fix-869-worked-for-toast`, never `Implementer`). Generic names (`Implementer`, `worker`, `helper`) and repeats are rejected: retry with names that say what and where.

Write each task so it stands alone: goal, files, constraints, the project notes that apply, and how to verify. A child sees none of your conversation.

## Collect results

Choose one:

- **Collect now.** Set `await: "all"` (or `"any"`) and `timeoutSeconds` on `delegate_task`, or call `ace_wait` with the thread ids. `ace_wait` also works for any other thread you can read.
- **Collect later.** End your turn. Settled results arrive as a new turn. Results already read through `ace_wait` don't arrive again.

Handle each wait status:

- `ready`: check each child's result against its task before you use it.
- `needs_you`: a child waits on the person. Tell the person what it asks, and treat it as unfinished.
- `timeout`: the children keep working. Wait again.
- `interrupted`: ace restarted. Wait again.

A failed or cancelled child is not done. Check one child with `ace_agent_status`, or the whole tree compactly with `ace_agents_status`. Use `ace_wait` for waiting, never a polling loop.

## Steer children

- `ace_agent_message` sends follow-up work to the same child.
- `ace_agent_cancel` stops a child and its descendants. Read its status to confirm it stopped.
- `ace_agent_result` reads a settled outcome. It returns `not_ready` while anything in the tree still works or waits on the person.
- `ace_ask`, when offered, asks the person a question and waits for the answer. Delegated children get it.

## Other machines

- **Paired machines** (`ace_machines`): pass `machine` and `project` to `delegate_task`. That machine applies its own access mode and consent. `ace_wait` and `ace_agents_status` cover the child there too.
- **Paired devices** (`ace_device_list`): `ace_device_delegate` with an explicit `hostId` and `workspaceId`. Follow it with `ace_device_task_status`, `ace_device_task_wait` and `ace_device_task_cancel`. On a remote task, call `ace_device_task_publish` once before finishing to return files. Workspaces are never overwritten or merged.
