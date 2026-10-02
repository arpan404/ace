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
  const session = await preparePluginSession(manager, provider, root);
  try {
    const process = spawn({
      ...options,
      args: [...(options.args ?? []), ...session.args],
      env: launchEnvironment(options.env, session.env),
    });
    const exited = process.exited.finally(session.close);
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
