# 0099: Chats without a project

Date: 2026-10-23. Status: accepted.

## Context

Every thread belonged to a project, and a project was a folder the person added. Asking an
agent a quick question, or trying ace for the first time, meant adding a project first. The owner
asked for chats with no project.

Every provider CLI still needs a folder to run in, and the daemon assumes in many places that a
thread has a project (`threads.workspace_id` is required, thread creation, moving, search, the
sidebar, agent tools, the iOS client). Making the project optional would touch all of them.

## Decision

A chat is a thread whose project is a hidden **chat project** ace makes for it.

- **One chat project per chat.** `workspace.chat.create` makes a fresh empty folder at
  `<data dir>/chats/<id>` and registers it as a project with `kind: "chat"`
  (`workspace_metadata.kind`). The client then sends `thread.create` into it as usual. In local
  mode a thread's folder is its project's folder, which moving a thread and mode detection
  already rely on; one project per chat keeps that true. A shared "Chats" project with a
  subfolder per chat would break it.
- **Hidden.** `Project.kind` and `ThreadDetails.workspace.kind` carry `chat`. Clients leave chat
  projects out of every project list, picker, filter and move destination, and show chat threads
  without a project name. The daemon leaves them out of recent projects, the folder picker's
  hints and the agent `projects_find` lookup. Rename, edit and remove refuse with `chat_project`,
  and so does moving a thread into a chat.
- **No Git.** The folder is not a repository, so the existing "not a Git repository" handling
  applies: no worktree mode, branches or pull requests.
- **Moving out.** "Move to project" works unchanged: the chat's thread moves to the project's
  folder. Files the agent wrote in the chat folder do not move with it.
- **Cleanup.** When none of a chat project's threads are kept (all deleted, or moved to other
  projects) the project is unregistered and its folder removed. A chat project that never got a
  thread (the client failed between the two commands) is removed after an hour. The sweep runs at
  startup and after each thread deletion or move, and only ever removes a direct child of the
  chats folder (`apps/daemon/src/chat-projects.ts`).
- **Access.** Chats use the same default access mode as projects.

## Consequences

- Starting a chat is two commands. A crash between them leaves an empty hidden project that the
  sweep removes later.
- Each chat adds a `workspaces` row. They are small, and deleted chats are unregistered.
- Older clients that don't know `kind` show chat projects as ordinary projects named "Chat".
