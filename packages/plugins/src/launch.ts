import { spawnSupervised, type SpawnOptions } from "@ace/provider-kit/process";
import { launchEnvironment } from "./launch-config.ts";
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
  } = {},
) {
  if (options.killGroupOnExit === false)
    throw new Error("Plugin launches require process-group cleanup on leader exit");
  const session = await (seams.prepare ?? preparePluginSession)(manager, provider, root);
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
    const exited = process.exited.finally(() =>
      within(
        session.close().catch(() => {}),
        seams.releaseMs ?? PROJECTION_RELEASE_MS,
      ),
    );
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
    await session.close();
    throw error;
  }
}
