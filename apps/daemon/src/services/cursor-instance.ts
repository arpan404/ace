import { defaultCursorInstance, type CursorInstance } from "@ace/adapter-cursor/instance";
import { canonicalHome } from "@ace/accounts";
import type { ServiceContext } from "./types.ts";

/** Execution, catalog and SDK auth share accounts' canonical default home identity. */
export async function daemonCursorInstance({
  config,
  options,
}: ServiceContext): Promise<CursorInstance> {
  const instance = options.engine?.cursor?.instance ?? {
    ...defaultCursorInstance(config.dataDir),
    ...(config.cursorSdkHome ? { homeDir: config.cursorSdkHome } : {}),
  };
  return { ...instance, homeDir: await canonicalHome(instance.homeDir) };
}
