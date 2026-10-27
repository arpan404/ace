import {
  WorkspaceId,
  type EventPayload,
  type Project,
  type Thread,
  type ThreadDetails,
  type ThreadMovedFrom,
} from "@ace/protocol";

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
 * The thread's details in `project`: a local checkout of the project, with the pull requests and
 * issues it had there when it moves back to the project it last left. Git state (branch, head,
 * diff) is never carried over; the checkout is read again.
 */
export function movedThreadDetails(thread: Thread, project: Project): ThreadDetails {
  const links = thread.movedFrom?.workspaceId === project.id ? thread.movedFrom.links : {};
  return {
    ...links,
    workspace: project,
    mode: "local",
    worktree: project.path,
    ...(thread.details?.machine ? { machine: thread.details.machine } : {}),
  };
}

/** The forge links a move leaves behind, or nothing when the thread had none. */
function linksLeft(thread: Thread): ThreadMovedFrom | null {
  const details = thread.details;
  if (!details) return null;
  const links = {
    ...(details.repository ? { repository: details.repository } : {}),
    ...(details.linkedPrs ? { linkedPrs: details.linkedPrs } : {}),
    ...(details.linkedPr ? { linkedPr: details.linkedPr } : {}),
    ...(details.linkedIssues ? { linkedIssues: details.linkedIssues } : {}),
  };
  return Object.keys(links).length
    ? { workspaceId: WorkspaceId.parse(thread.workspaceId), links }
    : null;
}

export function threadMoveEvents(thread: Thread, project: Project): EventPayload[] {
  return [
    { type: "thread.updated", workspaceId: project.id },
    {
      type: "thread.client.updated",
      changes: {
        details: movedThreadDetails(thread, project),
        // The links this move leaves behind, for a move back (Undo) to restore; a move back
        // uses them up.
        movedFrom: thread.movedFrom?.workspaceId === project.id ? null : linksLeft(thread),
      },
    },
  ];
}
