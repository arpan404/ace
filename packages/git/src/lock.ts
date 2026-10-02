import { toGitError } from "./types.ts";

const pending = new Map<string, Promise<void>>();

// Shared by all service instances. Keys are canonical worktree roots, not caller aliases.
export async function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  pending.set(key, next);
  await previous;
  try {
    return await operation();
  } catch (error) {
    throw toGitError(error);
  } finally {
    release();
    if (pending.get(key) === next) pending.delete(key);
  }
}
