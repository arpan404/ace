import type { DelegationRequest } from "@ace/protocol";

/**
 * Whether an outside grant may delegate this child (ADR 0117): only on this machine, and only
 * in the parent's own project, as its checkout or a new worktree of it. `existingPath` is the
 * request's existing worktree resolved on disk, and `checkout` the project's checkout, so a
 * symlink or `..` can't name somewhere else. A grant is never offered another machine.
 */
export function spawnAllowed(
  request: Pick<DelegationRequest, "machine" | "project" | "workspace">,
  checkout: string,
  existingPath: string | undefined,
): boolean {
  if (request.machine !== undefined || request.project !== undefined) return false;
  const workspace = request.workspace;
  if (!workspace || workspace.kind === "project" || workspace.kind === "new_worktree") return true;
  return existingPath !== undefined && existingPath === checkout;
}

/**
 * A client's key, namespaced by its grant, so two grants' retries never meet one receipt.
 * Undefined when the two don't fit one key.
 */
export function grantKey(grantId: string, key: string): string | undefined {
  const value = `${grantId}.${key}`;
  return value.length <= 128 && /^[a-zA-Z0-9_.-]+$/.test(value) ? value : undefined;
}
