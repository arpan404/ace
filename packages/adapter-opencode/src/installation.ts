import { realpath, stat } from "node:fs/promises";

/**
 * The file an OpenCode path runs right now: its resolved path, device, inode, size,
 * modification and change time. An update, a reinstall or a retargeted link changes it.
 */
export async function installationIdentity(path: string): Promise<string | undefined> {
  try {
    const resolved = await realpath(path);
    const info = await stat(resolved, { bigint: true });
    return [resolved, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
  } catch {
    return undefined;
  }
}
