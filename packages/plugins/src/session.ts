import { materializeProjection, removeProjection } from "./materialize.ts";
import { projectPlugins } from "./project.ts";
import type { PluginManager } from "./manager.ts";
import type { Provider } from "./types.ts";

/** Adapter launch boundary. The session owns this root until its provider has stopped. */
export async function preparePluginSession(
  manager: PluginManager,
  provider: Provider,
  root: string,
) {
  const projection = projectPlugins(provider, await manager.installed(), { root });
  await materializeProjection(projection, { root });
  return {
    env: projection.env,
    args: projection.args,
    sessionConfig: projection.sessionConfig,
    unsupported: projection.unsupported,
    close: () => removeProjection(root),
  };
}
