import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { spawnSupervised, type SpawnOptions } from "@ace/provider-kit/process";
import { launchEnvironment } from "./launch-config.ts";
import { claimLaunchDirectory, sweepLaunchDirectories } from "./launch-directory.ts";
import { preparePluginSession } from "./session.ts";
import type { PluginManager } from "./manager.ts";
import type { Provider } from "./types.ts";

/** How long a plugin process's exit waits for its projection's removal before it is reported. */
export const PROJECTION_RELEASE_MS = 2_000;

/** Resolves when `work` settles or after `ms`, whichever is first; `work` carries on regardless. */
function within(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    void work.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function launchPluginProcess(
  manager: PluginManager,
  provider: Provider,
  root: string,
  options: SpawnOptions,
  spawn = spawnSupervised,
  seams: {
    /** Writes the session's projection; tests stand in for a filesystem that stalls. */
    prepare?: typeof preparePluginSession;
    releaseMs?: number;
    id?: () => string;
    /** Runs between the sweep reading the root and acting on it; tests stall it here. */
    sweepListed?: () => Promise<void>;
    /** Told of each sweep this launch starts, which is never awaited. */
    swept?: (sweep: Promise<void>) => void;
  } = {},
) {
  if (options.killGroupOnExit === false)
    throw new Error("Plugin launches require process-group cleanup on leader exit");
  // Each launch projects into a directory of its own, held while it lives, so an earlier
  // launch's cleanup, however late, removes only its own files and holds only its own lock.
  const directory = await claimLaunchDirectory(root, (seams.id ?? randomUUID)());
  const sweep = sweepLaunchDirectories(root, directory.name, seams.sweepListed);
  seams.swept?.(sweep);
  let prepared: Awaited<ReturnType<typeof preparePluginSession>>;
  try {
    prepared = await (seams.prepare ?? preparePluginSession)(manager, provider, directory.path);
  } catch (error) {
    directory.release();
    throw error;
  }
  const session = {
    ...prepared,
    close: () =>
      prepared.close().finally(() => rm(directory.path, { recursive: true, force: true })),
  };
  try {
    const process = spawn({
      ...options,
      args: [...(options.args ?? []), ...session.args],
      env: launchEnvironment(options.env, session.env),
    });
    // Exit waits for the session projection's removal, so a caller that saw it normally finds
    // the projection gone, but only for a bounded time: a removal stalled on a hung filesystem
    // carries on alone, and the exit (with the launch slot and root its callers free on it) is
    // reported anyway. A leftover projection is replaced by the root's next launch. A failed
    // removal is cleanup and cannot change the exit result.
    const exited = process.exited.finally(() => {
      // The launch is over once its process is: from here its directory may be swept.
      directory.release();
      return within(
        session.close().catch(() => {}),
        seams.releaseMs ?? PROJECTION_RELEASE_MS,
      );
    });
    return {
      ...process,
      exited,
      stop: async (stopOptions?: { graceMs?: number }) => {
        await process.stop(stopOptions);
        return exited;
      },
      sessionConfig: session.sessionConfig,
      unsupported: session.unsupported,
    };
  } catch (error) {
    directory.release();
    await session.close();
    throw error;
  }
}
