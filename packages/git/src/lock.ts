import { withMutationLease, mutationLeaseId, type LeaseProbe } from "./mutation-leases.ts";
import { scheduleProbe } from "./lease-owner.ts";
import { GitError, toGitError } from "./types.ts";

const pending = new Map<string, Promise<void>>();

// Shared by all service instances. Keys are canonical worktree roots, not caller aliases.
/** Wait for the operation ahead, or stop waiting when `signal` aborts. */
function waitTurn(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener("abort", abort, { once: true });
    void previous.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
  });
}
const cancelled = () => new GitError("git_cancelled", "Git read cancelled before it started");
export async function serial<T>(
  key: string,
  operation: () => Promise<T>,
  id: () => string = mutationLeaseId,
  probe: LeaseProbe = { schedule: scheduleProbe },
  signal?: AbortSignal,
): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve();
  const { promise: next, resolve: release } = Promise.withResolvers<void>();
  pending.set(key, next);
  try {
    await waitTurn(previous, signal);
  } catch (error) {
    // A caller that stops waiting keeps its place until the operation ahead of it ends, so the
    // queue order behind it is unchanged; it never runs.
    void previous.then(() => {
      release();
      if (pending.get(key) === next) pending.delete(key);
    });
    throw error;
  }
  try {
    return await withMutationLease(key, id, operation, probe);
  } catch (error) {
    throw toGitError(error);
  } finally {
    release();
    if (pending.get(key) === next) pending.delete(key);
  }
}
