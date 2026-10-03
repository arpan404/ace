import { WorkspaceId } from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

const defaults = ["main", "master", "trunk", "develop"];

/** The usual default branch first, then the rest as the daemon listed them. */
export function defaultFirst(branches: readonly string[]): string[] {
  const first = defaults.find((name) => branches.includes(name));
  return first ? [first, ...branches.filter((branch) => branch !== first)] : [...branches];
}

const none: readonly string[] = [];

/**
 * Branches a worktree can start from, from the daemon's workspace service (`branches.list`),
 * default branch first; empty while loading or when the project's branches can't be read.
 */
export function useBranches(project: string | undefined): readonly string[] {
  return (
    useDaemonQuery({
      queryKey: ["new-thread", "branches", project],
      enabled: project !== undefined,
      staleTime: 30_000,
      read: async (client, signal) => {
        const reply = await client.request(
          {
            type: "workspace.request",
            operation: { op: "branches.list", workspaceId: WorkspaceId.parse(project) },
          },
          { signal },
        );
        return reply.result.kind === "branches" ? defaultFirst(reply.result.branches) : none;
      },
    }).data ?? none
  );
}
