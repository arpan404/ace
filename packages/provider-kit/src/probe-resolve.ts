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
 * `resolve`, given up the moment `signal` aborts (with its reason: the caller's abort, a global
 * stop or the probe's deadline), even while a filesystem read under it hangs on a stalled mount:
 * the read is left to finish alone, and nothing is started from what it finds.
 */
export async function resolveWithin(
  resolve: (signal: AbortSignal) => Promise<ProbeLaunch>,
  signal: AbortSignal,
): Promise<ProbeLaunch> {
  const given = Promise.withResolvers<never>();
  const abort = () => given.reject(signal.reason);
  if (signal.aborted) abort();
  signal.addEventListener("abort", abort, { once: true });
  const resolving = resolve(signal);
  // Given up, it may still fail later: that failure is no one's.
  resolving.catch(() => {});
  try {
    return await Promise.race([resolving, given.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
