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
export function movedThreadDetails(thread: Thread, project: Project): ThreadDetails {
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
    { type: "thread.client.updated", changes: { details: movedThreadDetails(thread, project) } },
  ];
}
