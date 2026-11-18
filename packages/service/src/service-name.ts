import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

/**
 * A login service belongs to its home (ADR 0185). The default home, `~/.ace`, keeps the names
 * ace has always registered, so installs from before this rule keep working and nothing
 * migrates. Every other home (a dev, test or second home) gets its own stable name: the
 * default name plus a short hash of the home's canonical path, so it never registers over,
 * restarts or removes another home's service. A home that already runs under the default name,
 * registered by a build from before the rule, keeps it. Pure: the I/O shell passes in the
 * canonical paths and the registrations it read.
 */
export type ServicePlatform = "darwin" | "linux" | "win32";

/** Whether `a` and `b` are the same path string on `platform`, once normalised. */
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

const defaultHome = (userHome: string, platform: ServicePlatform) =>
  (platform === "win32" ? win32 : posix).join(userHome, ".ace");

/**
 * The tag of `home`'s own names, from paths alone: empty for the default home, else a hash of
 * its path. Callers on a real machine pass canonical paths (`chooseServiceIdentity`).
 */
export function homeServiceTag(home: string, userHome: string, platform: ServicePlatform): string {
  if (sameHomePath(home, defaultHome(userHome, platform), platform)) return "";
  return createHash("sha256").update(homeKey(home, platform)).digest("hex").slice(0, 10);
}

/** `base` for an empty `tag`, else `base<separator><tag>`. */
export function taggedName(base: string, separator: "." | "-", tag: string): string {
  return tag ? `${base}${separator}${tag}` : base;
}

/** What the I/O shell gives `chooseServiceIdentity`: paths, and the registrations it reads. */
export interface ServiceIdentityInput {
  platform: ServicePlatform;
  /** The home as it was asked for (ACE_HOME). */
  home: string;
  /** The person's home folder. */
  userHome: string;
  /** The path with links resolved and each name spelled as the volume stores it. */
  canonical(path: string): string;
  /** The registration under the name `tag` gives, undefined when there is none. Throws when unreadable. */
  registration(tag: string): string | undefined;
  /** The home a registration runs, decoded; undefined when it names none ace could have written. */
  homeOf(content: string): string | undefined;
  /** Names the default-name registration in an error. */
  sharedName: string;
}

/** Which names `home`'s service has, and the spelling of the home to render it with. */
export interface ServiceIdentity {
  tag: string;
  /**
   * The home's spelling: an existing registration of the same folder under another spelling
   * (a link, or another case on a case-insensitive volume) is kept, so it is recognised as this
   * home's and every action reaches it; otherwise the home as asked for.
   */
  home: string;
}

/**
 * The default home has the default name. Any other home has it only when the registration
 * there already runs that same folder; a registration there that names no home ace could have
 * written is refused rather than guessed around, since it may be this home's. Everything else
 * gets its own hashed name.
 */
export function chooseServiceIdentity(input: ServiceIdentityInput): ServiceIdentity {
  const { platform, canonical } = input;
  const home = canonical(input.home);
  const same = (other: string) => sameHomePath(canonical(other), home, platform);
  let tag = homeServiceTag(home, canonical(input.userHome), platform);
  if (tag) {
    const shared = input.registration("");
    if (shared !== undefined) {
      const owner = input.homeOf(shared);
      if (owner === undefined)
        throw new Error(
          `Can't tell which ace home the service ${input.sharedName} runs. Refusing to register ${input.home}'s service beside it, since it may be this home's; remove it yourself if it isn't ace's.`,
        );
      if (same(owner)) tag = "";
    }
  }
  const own = tag ? input.registration(tag) : input.registration("");
  const registered = own === undefined ? undefined : input.homeOf(own);
  return { tag, home: registered !== undefined && same(registered) ? registered : input.home };
}
