import { assertCompatibleService } from "./compatibility.ts";
import { assertCompatibleHome } from "./home.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { lstat, rm } from "node:fs/promises";
import { z } from "zod";
import { planService, ServiceEnvironment } from "./plan.ts";
import { UserService } from "./service.ts";
import { runProcess } from "./process.ts";
import { withInstallLock } from "./files.ts";
/** OS/environment discovery belongs only in this local I/O boundary. */
export function localService(dataDir: string) {
  assertCompatibleHome(dataDir);
  const plan = planService({
    environment: ServiceEnvironment.parse(process.env),
    updatePolicy: process.env.ACE_AUTO_UPDATE === "0" ? "manual" : "daily",
    platform: z.enum(["darwin", "linux"]).parse(process.platform),
    home: homedir(),
    dataDir,
    executable: join(dataDir, "bin/ace"),
    path: process.env.PATH ?? "/usr/bin:/bin",
    uid: process.getuid?.() ?? 0,
  });
  return new UserService(plan, runProcess, () => assertCompatibleService(plan, dataDir));
}
export async function serviceCommand(dataDir: string, args: string[]) {
  assertCompatibleHome(dataDir);
  const action = z.enum(["install", "uninstall", "start", "stop", "status"]).parse(args[0]);
  if (args.length !== 1) throw new Error("Usage: ace service install|uninstall|start|stop|status");
  if (action === "install" && !existsSync(join(dataDir, "bin/ace")))
    throw new Error("Install a daemon artifact before registering its service");
  if (action !== "uninstall") return localService(dataDir).perform(action);
  return withInstallLock(dataDir, async () => {
    if (existsSync(join(dataDir, "update.json")))
      throw new Error("Recover the pending update before uninstalling");
    const result = await localService(dataDir).perform(action);
    for (const name of ["bin/ace", "current", "previous", "releases"]) {
      const path = join(dataDir, name);
      if (name === "releases" && existsSync(path) && !(await lstat(path)).isDirectory())
        throw new Error("Invalid releases directory");
      await rm(path, { recursive: true, force: true });
    }
    return result;
  });
}
