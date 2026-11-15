import type { ThreadRecord } from "@ace/client-react/thread-field";

/*
 * Single fields of a thread for `useThreadField`, at module scope so they never re-subscribe.
 * Each yields a value that keeps its identity while that field is unchanged.
 */

export const threadWorkspaceId = (thread: ThreadRecord) => thread.workspaceId;
export const threadProvider = (thread: ThreadRecord) => thread.provider;
export const threadRootAgentId = (thread: ThreadRecord) => thread.rootAgentId;
export const threadStatus = (thread: ThreadRecord) => thread.status;
export const threadModel = (thread: ThreadRecord) => thread.execution?.model;

/** The thread's checkout: its worktree, else its workspace's folder, without a trailing slash. */
export const threadCheckoutRoot = (thread: ThreadRecord) =>
  (thread.details?.worktree ?? thread.details?.workspace?.path)?.replace(/\/+$/, "");
