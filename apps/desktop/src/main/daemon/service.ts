import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SupervisorPorts } from "./supervisor.ts";

const ServiceState = z.object({ active: z.boolean() });

/** `ace service …` through @ace/service, loaded on first use (it also carries the updater). */
async function serviceCommand(home: string, args: string[]): Promise<unknown> {
  return (await import("@ace/service")).serviceCommand(home, args);
}

/**
 * The login service installed by `ace service install` (launchd or systemd --user). It is
 * only considered when a standalone installation exists in ACE_HOME (`bin/ace`), which the
 * service requires; otherwise the app runs its own daemon.
 */
export function loginService(home: string): SupervisorPorts["service"] {
  if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
  if (!existsSync(join(home, "bin/ace"))) return undefined;
  return {
    active: async () => ServiceState.parse(await serviceCommand(home, ["status"])).active,
    start: async () => {
      ServiceState.parse(await serviceCommand(home, ["start"]));
    },
  };
}
