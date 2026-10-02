import { startDaemonMcp } from "../mcp.ts";
import type { ServiceContext } from "./types.ts";
export async function startMcp(context: ServiceContext): Promise<void> {
  const { options, store, resources, services } = context;

  const mcp = await startDaemonMcp(store, options.toolkits ?? []);
  resources.own(() => mcp.close());
  services.mcp = mcp;
}
