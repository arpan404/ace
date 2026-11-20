import { findInstalledExecutable } from "./discovery/shim-resolver.ts";
import { probeLaunch } from "./discovery/probe-launch.ts";
import { VersionManagerToolMissingError } from "./discovery/version-manager-shim.ts";

export interface ProbeLaunch {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

/**
 * What a probe runs: never a version manager's shim, which can install or update its tool when
 * it runs, but the installed binary its manager names, with an interpreter and PATH that reach
 * no shim either. Reads the filesystem.
 */
export async function resolveProbeLaunch(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: { signal: AbortSignal; cwd?: string | undefined },
): Promise<ProbeLaunch> {
  const scope = {
    signal: options.signal,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  };
  const found = await findInstalledExecutable(command, env, scope);
  if (found && "refused" in found) throw found.refused;
  if (found && "absent" in found) throw new VersionManagerToolMissingError(found.path);
  return probeLaunch(found && "run" in found ? found.run : command, args, env, scope);
}

/**
 * `resolve`, given up the moment `signal` aborts (with its reason) or `timeoutMs` passes, even
 * while a filesystem read under it hangs on a stalled mount: the read is left to finish alone,
 * and nothing is started from what it finds.
 */
export async function resolveWithin(
  resolve: (signal: AbortSignal) => Promise<ProbeLaunch>,
  signal: AbortSignal,
  timeoutMs: number,
  schedule: (callback: () => void, milliseconds: number) => () => void,
): Promise<ProbeLaunch> {
  const deadline = new AbortController();
  const cancel = schedule(() => deadline.abort(new Error("Probe timed out")), timeoutMs);
  const bounded = AbortSignal.any([signal, deadline.signal]);
  let stopListening = () => {};
  const given = new Promise<never>((_, reject) => {
    const abort = () => reject(bounded.reason);
    if (bounded.aborted) abort();
    bounded.addEventListener("abort", abort, { once: true });
    stopListening = () => bounded.removeEventListener("abort", abort);
  });
  const resolving = resolve(bounded);
  // Given up, it may still fail later: that failure is no one's.
  resolving.catch(() => {});
  try {
    return await Promise.race([resolving, given]);
  } finally {
    cancel();
    stopListening();
  }
}
