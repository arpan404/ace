import type { WorkspaceId } from "@ace/protocol";

/** Reads a checkout's `origin`, as `@ace/git`'s `GitTransfer.transferOrigin` does. */
export interface OriginReader {
  transferOrigin(path: string): Promise<{ url: string; normalized: string } | undefined>;
}

/** The most projects one lookup reads `origin` for. */
const lookupLimit = 64;

/**
 * The first of `projects` whose `origin` is the same repository as `normalized` (a
 * `normalizeRemoteUrl` key). A checkout whose origin can't be read is skipped, not fatal.
 */
export async function sameOriginProject(
  git: OriginReader,
  projects: readonly { workspaceId: WorkspaceId; path: string }[],
  normalized: string,
): Promise<WorkspaceId | undefined> {
  for (const project of projects.slice(0, lookupLimit)) {
    const origin = await git.transferOrigin(project.path).catch(() => undefined);
    if (origin && origin.normalized === normalized) return project.workspaceId;
  }
  return undefined;
}
