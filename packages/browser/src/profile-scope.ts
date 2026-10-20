import { createHash } from "node:crypto";
import { join } from "node:path";
import type { BrowserProfileScope } from "@ace/protocol";

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

/**
 * The directory of the kept profile ace's Chrome opens a thread's persistent browser in, under
 * `<data>/browser`: the shared `profile` for `global`, else one under `profiles/` per project or
 * per thread. Ids are hashed, never trusted as paths.
 */
export function scopedProfileDir(
  root: string,
  scope: BrowserProfileScope,
  ids: { threadId: string; workspaceId: string },
): string {
  if (scope === "project") return projectProfileDir(root, ids.workspaceId);
  if (scope === "thread") return threadProfileDir(root, ids.threadId);
  return join(root, "profile");
}
export function projectProfileDir(root: string, workspaceId: string): string {
  return join(root, "profiles", `project-${digest(workspaceId)}`);
}
export function threadProfileDir(root: string, threadId: string): string {
  return join(root, "profiles", `thread-${digest(threadId)}`);
}
