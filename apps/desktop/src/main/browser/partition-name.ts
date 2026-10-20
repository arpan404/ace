import { createHash } from "node:crypto";
import type { BrowserProfileScope } from "@ace/protocol";

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

/**
 * The persistent partition (without its `persist:` prefix) a thread's page opens in, by the
 * daemon's `browser.profileScope`: one shared by every project, one per project, or the
 * thread's own. Omitted (an older daemon) is the thread's own, as before scopes existed. Ids
 * are hashed, never used as directory names.
 */
export function persistentPartitionName(
  scope: BrowserProfileScope | undefined,
  ids: { threadId: string; workspaceId: string },
): string {
  if (scope === "global") return "ace-browser-global";
  if (scope === "project") return projectPartitionName(ids.workspaceId);
  return threadPartitionName(ids.workspaceId, ids.threadId);
}
export function projectPartitionName(workspaceId: string): string {
  return `ace-browser-project-${digest(workspaceId)}`;
}
export function threadPartitionName(workspaceId: string, threadId: string): string {
  return `ace-browser-${digest(`${workspaceId}:${threadId}`)}`;
}
