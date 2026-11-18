import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { runProcess } from "./process.ts";
import { currentUserSid } from "./windows-user.ts";
import { sameHomePath } from "./service-name.ts";
import {
  registeredSpadeHome,
  spadeServicePlan,
  spadeTaskName,
  type SpadeAccount,
  type SpadePlatform,
  type SpadeServicePlan,
} from "./spade-plan.ts";
import { readOwnFile } from "./spade-registration.ts";

/** The Windows task registered under the default name, `\ace-next-spade`. */
export const sharedSpadeTask = `\\${spadeTaskName}`;

/**
 * Spade's service plan for `home`, given what is registered under the default name: on Windows
 * `sharedTask` is that task as `schtasks /Query /XML` printed it (undefined when there is none);
 * elsewhere the default plist or unit is read here. A home already registered under the default
 * name, by a build from before ADR 0185, keeps that name; every other home gets its own.
 */
export function spadePlanBesideShared(
  home: string,
  platform: SpadePlatform,
  account: SpadeAccount,
  sharedTask: string | undefined,
): SpadeServicePlan {
  const path = platform === "win32" ? win32 : posix;
  const shared = path.join(account.userHome, ".ace");
  if (sameHomePath(home, shared, platform)) return spadeServicePlan(home, platform, account);
  let sharedNameHome: string | undefined;
  try {
    const registration =
      platform === "win32"
        ? sharedTask
        : readOwnFile(spadeServicePlan(shared, platform, account).file);
    if (registration !== undefined) sharedNameHome = registeredSpadeHome(platform, registration);
  } catch {
    // An unreadable registration isn't this home's: its own name is used, and checked as usual.
  }
  return spadeServicePlan(home, platform, { ...account, sharedNameHome });
}

/**
 * Spade's service plan for `home` on this machine, for this account. The OS lookups live here,
 * in the I/O shell; `spadeServicePlan` itself stays pure.
 */
export async function localSpadePlan(home: string): Promise<SpadeServicePlan> {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32")
    throw new Error(`Spade's service is not available on ${platform}`);
  const target: SpadePlatform = platform;
  const account: SpadeAccount = {
    userHome: homedir(),
    uid: process.getuid?.() ?? 0,
    ...(target === "win32"
      ? { sid: await currentUserSid(), systemRoot: process.env.SystemRoot ?? "C:\\Windows" }
      : {}),
  };
  let sharedTask: string | undefined;
  if (target === "win32") {
    const query = await runProcess("schtasks.exe", ["/Query", "/TN", sharedSpadeTask, "/XML"]);
    if (query.code === 0) sharedTask = query.stdout;
  }
  return spadePlanBesideShared(home, target, account, sharedTask);
}
