import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

/**
 * A login service belongs to its home (ADR 0185). The default home, `~/.ace`, keeps the names
 * ace has always registered, so installs from before this rule keep working and nothing
 * migrates. Every other home (a dev, test or second home) gets its own stable name: the
 * default name plus a short hash of the home's path, so it never registers over, restarts or
 * removes another home's service. A home that already runs under the default name, registered
 * by a build from before the rule, keeps it. Pure: names only, no I/O.
 */
export type ServicePlatform = "darwin" | "linux" | "win32";

/** Who the default name belongs to: the default home, or the home already registered under it. */
export interface ServiceNameOwner {
  /** The person's home folder: its `.ace` is the default home. */
  userHome: string;
  /** The home the service registered under the default name runs, when there is one. */
  sharedNameHome?: string | undefined;
}

/** Whether `a` and `b` name the same home folder on `platform`. */
export function sameHomePath(a: string, b: string, platform: ServicePlatform): boolean {
  return homeKey(a, platform) === homeKey(b, platform);
}

function homeKey(value: string, platform: ServicePlatform): string {
  const path = platform === "win32" ? win32 : posix;
  // The plans parse both as absolute first; a trailing separator is the same folder.
  const normal = path
    .normalize(value)
    .replace(platform === "win32" ? /(?<=[^:\\/])[\\/]+$/ : /(?<=.)\/+$/, "");
  // Windows paths are case-insensitive: one home is one service whatever its spelling.
  return platform === "win32" ? normal.toLowerCase() : normal;
}

/** What tells `home`'s services apart: empty for the default name, else a hash of its path. */
export function homeServiceTag(
  home: string,
  owner: ServiceNameOwner,
  platform: ServicePlatform,
): string {
  const path = platform === "win32" ? win32 : posix;
  if (sameHomePath(home, path.join(owner.userHome, ".ace"), platform)) return "";
  if (owner.sharedNameHome !== undefined && sameHomePath(home, owner.sharedNameHome, platform))
    return "";
  return createHash("sha256").update(homeKey(home, platform)).digest("hex").slice(0, 10);
}

/** `base` when `home` has the default name, else `base<separator><tag>`. */
export function homeServiceName(
  base: string,
  separator: "." | "-",
  home: string,
  owner: ServiceNameOwner,
  platform: ServicePlatform,
): string {
  const tag = homeServiceTag(home, owner, platform);
  return tag ? `${base}${separator}${tag}` : base;
}
