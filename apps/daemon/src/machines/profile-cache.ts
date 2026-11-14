import { statSync } from "node:fs";
import type { RemoteProfile } from "../cli/profiles.ts";

/**
 * A file's identity and last change, or undefined when it is absent. The profiles file is SQLite
 * in rollback-journal mode, so every committed change rewrites it and moves this.
 */
export function fileStamp(path: string): string | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return undefined;
  }
}

export interface ProfileCacheDeps {
  /** What the profiles file looks like on disk now (size, times, inode), or undefined if absent. */
  stamp(): string | undefined;
  /** Reads every paired machine; throws when the pairings can't be read. */
  read(): RemoteProfile[];
  now(): number;
  /** Read again at least this often, even when the file looks unchanged. */
  maxAgeMs: number;
}

/**
 * The paired machines, read again only when their file changed on disk (`ace remote add`,
 * Settings linking a machine, a removal) or the last read is `maxAgeMs` old. A failed read is
 * never cached: the next call reads again, and the error reaches the caller as before.
 */
export function cachedProfiles(deps: ProfileCacheDeps): () => RemoteProfile[] {
  let cached: { stamp: string | undefined; at: number; profiles: RemoteProfile[] } | undefined;
  return () => {
    const stamp = deps.stamp();
    const now = deps.now();
    if (cached && cached.stamp === stamp && now - cached.at < deps.maxAgeMs) return cached.profiles;
    const profiles = deps.read();
    cached = { stamp, at: now, profiles };
    return profiles;
  };
}
