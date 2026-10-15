import { WorkspaceError } from "../sources/workspace-source.ts";

/**
 * The lease for a force push after `error`: the remote revision a non-fast-forward rejection
 * compared against. Undefined for any other failure, or when Git didn't know the remote's
 * revision (fetch first, then decide).
 */
export function forceLeaseOf(error: unknown): string | undefined {
  return error instanceof WorkspaceError && error.code === "git_push_rejected"
    ? error.remoteHead
    : undefined;
}
