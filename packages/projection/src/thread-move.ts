import type { Thread, ThreadDetails, Project, EventPayload } from "@ace/protocol";

/** Moving registration never transfers Git state or files between repositories. */
export function threadMoveError(thread: Thread): string | undefined {
  if (thread.deletedAt !== undefined) return "thread_not_found";
  if (!["new", "done", "failed"].includes(thread.status.state)) return "thread_busy";
  if (thread.details?.mode === "worktree") return "thread_move_requires_local_workspace";
  if (
    thread.details?.workspaceChange?.state === "preparing" ||
    thread.details?.workspaceChange?.uncertain
  )
    return "workspace_change_in_progress";
  return undefined;
}
/**
 * The thread's details in `project`: those it left there when it last moved away (branch, pull
 * requests, diff), when it moves back; otherwise a plain local checkout of the project.
 */
export function movedThreadDetails(thread: Thread, project: Project): ThreadDetails {
  const left = thread.movedFrom?.workspaceId === project.id ? thread.movedFrom.details : undefined;
  if (left)
    return {
      ...left,
      workspace: project,
      mode: "local",
      worktree: project.path,
      ...(thread.details?.machine ? { machine: thread.details.machine } : {}),
    };
  return {
    workspace: project,
    mode: "local",
    worktree: project.path,
    ...(thread.details?.machine ? { machine: thread.details.machine } : {}),
  };
}
export function threadMoveEvents(thread: Thread, project: Project): EventPayload[] {
  return [
    { type: "thread.updated", workspaceId: project.id },
    {
      type: "thread.client.updated",
      changes: {
        details: movedThreadDetails(thread, project),
        // What this move leaves behind, for a move back (Undo) to restore.
        movedFrom: thread.details
          ? { workspaceId: thread.workspaceId, details: thread.details }
          : null,
      },
    },
  ];
}
