---
name: ace-threads
description: Read and manage ace threads and project knowledge, such as other threads' work, PR links, project notes, queued messages and worktree handoff. Use before ace_thread_*, ace_context or ace_note_* tools.
---

# Threads and project knowledge

A **thread** is one conversation in the person's sidebar. Owned threads are this one and the threads it started. Read-only tools work on any thread in this project.

## Know the project

- `ace_context` reads in one call what ace already knows: `recent` threads with their outcomes, `changes` (branch, upstream, uncommitted paths), `prs` with CI state, `notes`, and `diagnostics` (this session's failed ace calls and what keeps the thread from settling). Pass only the `topics` you need.
- `ace_note_add` saves one lasting project fact for every future thread and provider, such as how to run the tests or a pitfall you hit. `ace_note_retire` removes a wrong one by its id from `ace_context`. Notes are facts; the person sees and edits them.

## Read threads

- `ace_threads_list` lists and searches this project's threads. `ace_thread_search` searches one thread's transcript.
- `ace_thread_read` reads metadata and a transcript page. Omit `threadId` for this thread. Page back with `before` set to the returned `itemsBefore`. A truncated part with a `source.streamId` continues through `ace_thread_read_output`.
- Handoff history from another provider pages through `ace_read_handoff` and `ace_read_handoff_chunk`.

## Pull requests

When you open or find the PR for this work, link it with `ace_thread_link_pr` (URL or number). The person then sees its state and CI on the thread. `ace_thread_list_prs` lists links; `ace_thread_unlink_pr` removes one and leaves the PR itself unchanged.

## Manage owned threads

- **Start:** `ace_thread_start` opens a new top-level thread. For child work whose result you need, use `delegate_task` (skill ace-agents).
- **Send:** `ace_thread_message` with `delivery` `queue`, `steer` or `restart`. `ace_queue_edit` and `ace_queue_reorder` change queued input before delivery.
- **Answer:** `ace_question_answer` answers a pending question. Permission approvals stay with the person.
- **Shape:** `ace_thread_rename`, `ace_thread_configure` (model and options), `ace_thread_fork`, `ace_thread_handoff` (move to a new Git worktree), `ace_thread_merge`, `ace_thread_interrupt`, `ace_thread_settle` (archive once settled) and `ace_thread_snooze`.
- **Previews:** `ace_preview_list` and `ace_preview_close` manage a thread's preview servers.

ace names new threads itself from their first message, so renaming is only for a title that has become wrong.

Mutating tools take a `requestId`: any stable id you choose. Repeating a call with the same id changes nothing twice.
