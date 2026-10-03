import { devicesToolkit } from "@ace/devices";
import { browserToolkit } from "@ace/browser";
import { screenToolkit } from "@ace/screen";
import { startDaemonMcp } from "../mcp.ts";
import type { ServiceContext } from "./types.ts";
export async function startMcp(context: ServiceContext): Promise<void> {
  const { options, store, resources, services } = context;

  const mcp = await startDaemonMcp(store, [
    ...(options.toolkits ?? []),
    ...(services.browser ? [browserToolkit(services.browser)] : []),
    ...(services.devices ? [devicesToolkit(services.devices)] : []),
    ...(services.screen ? [screenToolkit(services.screen)] : []),
  ]);
  resources.own(() => mcp.close());
  services.mcp = mcp;
}
