---
name: ace-threads
description: Read and manage ace threads, project knowledge and automations, such as other threads' work, PR links, project notes, queued messages, worktree handoff and scheduled prompts. Use before thread_*, context, note_* or automation_* tools.
---

# Threads and project knowledge

A **thread** is one conversation in the person's sidebar. Owned threads are this one and the threads it started. Read-only tools work on any thread in this project.

## Know the project

- `context` reads in one call what ace already knows: `status` (this thread, project, access mode, which ace tool groups are on), `recent` threads with their outcomes, `changes` (branch, upstream, uncommitted paths), `prs` with CI state, `notes`, and `diagnostics` (this session's failed ace calls and what keeps the thread from settling). Pass only the `topics` you need.
- `note_add` saves one lasting project fact for every future thread and provider, such as how to run the tests or a pitfall you hit. `note_retire` removes a wrong one by its id from `context`. Notes are facts; the person sees and edits them.

## Read threads

- `threads_find` lists and searches this project's threads; with `threadId` it searches inside one thread's transcript. Page with `cursor`.
- `thread_read` reads a thread's title, status, branch, linked PRs, preview servers and a transcript page. Omit `threadId` for this thread. Page back with `before` set to the returned `itemsBefore`. A truncated part with a `source.streamId` continues with `streamId` and `offset`.
- `handoff_read` pages the history a handoff from another provider cites (items, or one stream with `streamId`).

## Pull requests

When you open or find the PR for this work, link it with `thread_link_pr` (URL or number). The person then sees its state and CI on the thread. `thread_read` and `context` topic `prs` list links; `thread_link_pr { unlink: true }` removes one and leaves the PR itself unchanged.

## Manage owned threads

- **Start:** `thread_start` opens a new top-level thread, the way to give the person a separate or dedicated thread. Pass `project` (a name, folder path or id) to open it in another project on this machine; `projects_find` lists them. For child work whose result you need, use `delegate` (guide ace-agents).
- **Send:** `agent_message` with `delivery` `queue`, `steer` or `restart`. `queue_edit` replaces a queued entry's text or reorders pending entries before delivery.
- **Answer:** `question_answer` answers a pending question. Permission approvals stay with the person.
- **Change:** `thread_control` with an `action`: `rename` (omit `title` to retitle from the first message), `configure` (model and effort), `fork`, `handoff` (move to a new Git worktree on `branch`), `interrupt`, `settle`, `unsettle`, `snooze`, `close_preview`, or `rename_project`.
- **Settle:** `thread_control` `settle` moves a finished thread to Settled, as the person's Settle does. You can settle this thread before your turn ends: it settles once its work is done, and stays active if the turn fails or a question waits on the person. `unsettle` brings a thread back and cancels a pending settle.
- **Merge:** `thread_merge` merges a thread's worktree changes back. It overwrites files, so your provider may ask the person first.
- **Tell the person:** `notify` posts a notice and sends a notification, for something they should see while away.

ace names new threads itself from their first message, so renaming is only for a title that has become wrong.

## Automations

An automation is a saved prompt that runs as a child agent in this project, on demand or on a schedule.

- `automations_list` shows them with each schedule's next run; `runs: true` shows recent runs with their threads.
- `automation_put` creates or replaces one by `id`: `title`, `prompt`, and an optional `schedule` (`rrule` or `cron`, a timezone, and `startAt` on a whole minute).
- `automation_run` runs one now; `automation_remove` deletes it (your provider may ask the person first).

Mutating tools take a `requestId`: any stable id you choose. Repeating a call with the same id changes nothing twice.
