import { homedir } from "node:os";
import { canonicalPath } from "./canonical-path.ts";
import { runProcess } from "./process.ts";
import { currentUserSid } from "./windows-user.ts";
import { chooseServiceIdentity, homeServiceTag, taggedName } from "./service-name.ts";
import {
  registeredSpadeHome,
  spadeServicePlan,
  spadeTaskName,
  type SpadeAccount,
  type SpadePlatform,
  type SpadeServicePlan,
} from "./spade-plan.ts";
import { readOwnFile } from "./spade-registration.ts";

/** What finding a home's Spade service reads, injected so tests can stand in for both. */
export interface SpadeIdentityIo {
  /** Links resolved and names spelled as stored (`canonicalPath`). */
  canonical(path: string): string;
  /** Windows: the task `name` as `schtasks /Query /XML` prints it, undefined when there is none. */
  loadedTask(name: string): string | undefined;
}

/** The service manager's name for `plan`'s service. */
export const spadeServiceName = (plan: SpadeServicePlan) =>
  plan.platform === "linux" ? plan.unit : plan.platform === "darwin" ? plan.domain : plan.name;

/**
 * Spade's service plan for `home` (ADR 0185): the default home's names for the default home and
 * for a home registered under them by an earlier build, its own hashed names for any other. The
 * plist or unit is read here; a registration that may be this home's but can't be read as ace's
 * is refused, never stepped around.
 */
export function spadePlanFor(
  home: string,
  platform: SpadePlatform,
  account: SpadeAccount,
  io: SpadeIdentityIo,
): SpadeServicePlan {
  const planWith = (spelling: string, tag: string) =>
    spadeServicePlan(spelling, platform, { ...account, serviceTag: tag });
  const identity = chooseServiceIdentity({
    platform,
    home,
    userHome: account.userHome,
    canonical: io.canonical,
    registration: (tag) => {
      const plan = planWith(home, tag);
      return plan.platform === "win32" ? io.loadedTask(plan.name) : readOwnFile(plan.file);
    },
    homeOf: (content) => registeredSpadeHome(platform, content),
    sharedName: spadeServiceName(planWith(home, "")),
  });
  return planWith(identity.home, identity.tag);
}

/** The two task names `home`'s Spade can have on Windows: the default one and its own. */
export function spadeTaskNames(home: string, userHome: string): string[] {
  const own = homeServiceTag(canonicalPath(home), canonicalPath(userHome), "win32");
  return [...new Set([`\\${spadeTaskName}`, `\\${taggedName(spadeTaskName, "-", own)}`])];
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
  const tasks = new Map<string, string>();
  if (target === "win32")
    for (const name of spadeTaskNames(home, account.userHome)) {
      const query = await runProcess("schtasks.exe", ["/Query", "/TN", name, "/XML"]);
      if (query.code === 0) tasks.set(name, query.stdout);
    }
  return spadePlanFor(home, target, account, {
    canonical: canonicalPath,
    loadedTask: (name) => tasks.get(name),
  });
}
