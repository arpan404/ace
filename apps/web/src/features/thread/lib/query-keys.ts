import type { ForgePrStatus, ForgeRepository } from "@ace/protocol";

/** The thread checkout's query keys, shared by its reads and the changes that refresh them. */
export const detailsKey = (threadId: string) => ["thread", "details", threadId];
export const repositoryKey = (repository: ForgeRepository | undefined) => [
  repository?.host,
  repository?.owner,
  repository?.name,
];
export const prKey = (threadId: string) => ["thread", "pr", threadId];
export const statusKey = (threadId: string) => ["thread", "git-status", threadId];
/** The state the daemon publishes in a thread's `linkedPrs` for a forge status. */
export const linkState = (status: ForgePrStatus) =>
  status.state === "unknown" ? "open" : status.state;
