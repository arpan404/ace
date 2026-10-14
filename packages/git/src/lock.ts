import { withMutationLease, mutationLeaseId, type LeaseProbe } from "./mutation-leases.ts";
import { scheduleProbe } from "./lease-owner.ts";
import { toGitError } from "./types.ts";

const pending = new Map<string, Promise<void>>();

// Shared by all service instances. Keys are canonical worktree roots, not caller aliases.
export async function serial<T>(
  key: string,
  operation: () => Promise<T>,
  id: () => string = mutationLeaseId,
  probe: LeaseProbe = { schedule: scheduleProbe },
): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve();
  const { promise: next, resolve: release } = Promise.withResolvers<void>();
  pending.set(key, next);
  await previous;
  try {
    return await withMutationLease(key, id, operation, probe);
  } catch (error) {
    throw toGitError(error);
  } finally {
    release();
    if (pending.get(key) === next) pending.delete(key);
  }
}
