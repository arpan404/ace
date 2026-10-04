import { defaultCursorInstance, type CursorInstance } from "@ace/adapter-cursor";
import type { ServiceContext } from "./types.ts";

/** Execution and SDK auth must bind the same daemon-owned default home. */
export function daemonCursorInstance({ config, options }: ServiceContext): CursorInstance {
  return (
    options.engine?.cursor?.instance ?? {
      ...defaultCursorInstance(config.dataDir),
      ...(config.cursorSdkHome ? { homeDir: config.cursorSdkHome } : {}),
    }
  );
}
