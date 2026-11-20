import { spawnSupervised, type SpawnOptions } from "@ace/provider-kit/process";
import { launchEnvironment } from "./launch-config.ts";
import { preparePluginSession } from "./session.ts";
import type { PluginManager } from "./manager.ts";
import type { Provider } from "./types.ts";

export async function launchPluginProcess(
  manager: PluginManager,
  provider: Provider,
  root: string,
  options: SpawnOptions,
  spawn = spawnSupervised,
) {
  if (options.killGroupOnExit === false)
    throw new Error("Plugin launches require process-group cleanup on leader exit");
  const session = await preparePluginSession(manager, provider, root);
  try {
    const process = spawn({
      ...options,
      args: [...(options.args ?? []), ...session.args],
      env: launchEnvironment(options.env, session.env),
    });
    // Exit settles once the session projection is released, so a caller that saw the exit never
    // finds the projection still on disk. A failed close is cleanup and cannot change the exit result.
    const exited = process.exited.finally(() => session.close().catch(() => {}));
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
