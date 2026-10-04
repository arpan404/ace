import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { installedVersion } from "@ace/service/home";
import type { SupervisorPorts } from "./supervisor.ts";

const ServiceState = z.object({ active: z.boolean() });

/** `ace service …` through @ace/service, loaded on first use (it also carries the updater). */
async function serviceCommand(home: string, args: string[]): Promise<unknown> {
  return (await import("@ace/service")).serviceCommand(home, args);
}

/**
 * The login service installed by `ace service install` (launchd or systemd --user). It is
 * only considered when ACE_HOME holds this rewrite's own validated installation: #98's
 * `installedVersion` reads its release metadata and launcher, never running them, and refuses
 * a 0.x `bin/ace` or anything it can't validate. Otherwise the app runs its own daemon.
 */
export function loginService(home: string): SupervisorPorts["service"] {
  if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
  if (!existsSync(join(home, "bin/ace"))) return undefined;
  try {
    installedVersion(home);
  } catch {
    return undefined;
  }
  return {
    active: async () => ServiceState.parse(await serviceCommand(home, ["status"])).active,
    start: async () => {
      ServiceState.parse(await serviceCommand(home, ["start"]));
    },
  };
}
