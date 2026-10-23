import { close } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { win32 } from "node:path";
import { windowsDescriptorStats } from "./descriptor.ts";
import type { IdentifiedStats } from "./file-identity.ts";
import type { WorkspaceFileSystem } from "./runtime.ts";

/** Native port for pinned Windows path metadata.
 * The addon owns validation; this module never re-checks components.
 */
export interface WindowsNativePort {
  openRoot(path: string): number;
  openMetadataAt(parent: number, name: string): number;
  statFd(fd: number): unknown;
}

function closeFd(fd: number): Promise<void> {
  return new Promise((resolve, reject) =>
    close(fd, (error) => (error ? reject(error) : resolve())),
  );
}

/**
 * Windows path metadata from pinned handles as a WorkspaceFileSystem.
 *
 * stat follows via realpath(full) then a pinned metadata open; lstat resolves
 * only realpath(parent) then opens the leaf without following. Drive roots
 * have no parent/leaf split and use openRoot itself. Both observations run
 * fstat plus statFd on the same caller-held fd via windowsDescriptorStats, so
 * a pathname replacement cannot redirect them. Child and parent fds close on
 * every path, including a stat throw.
 *
 * These are path observations, not authorization. SafeRoot's expected versus
 * anchored identity checks remain required. All splitting uses the win32
 * owner, never the logic-global path or duplicated component policy.
 */
export function createWindowsFilesystem(native: WindowsNativePort): WorkspaceFileSystem {
  const stats = windowsDescriptorStats(native.statFd);

  async function validateRoot(input: string): Promise<void> {
    const root = win32.parse(input).root;
    // Let native policy reject namespaces, UNC and drive-relative inputs
    // before realpath can turn them into an ordinary drive path.
    if (root !== "" && (root.length !== 3 || root[1] !== ":")) {
      const fd = native.openRoot(input);
      await closeFd(fd);
    }
  }

  async function childStats(parentPath: string, leaf: string): Promise<IdentifiedStats> {
    const parent = native.openRoot(parentPath);
    try {
      const child = native.openMetadataAt(parent, leaf);
      try {
        return await stats.stat(child);
      } finally {
        await closeFd(child);
      }
    } finally {
      await closeFd(parent);
    }
  }

  async function pinned(canonical: string): Promise<IdentifiedStats> {
    if (win32.dirname(canonical) === canonical) {
      const root = native.openRoot(canonical);
      try {
        return await stats.stat(root);
      } finally {
        await closeFd(root);
      }
    }
    return childStats(win32.dirname(canonical), win32.basename(canonical));
  }

  async function stat(input: string): Promise<IdentifiedStats> {
    await validateRoot(input);
    return pinned(await realpath(input));
  }

  async function lstat(input: string): Promise<IdentifiedStats> {
    await validateRoot(input);
    const leaf = win32.basename(input);
    if (leaf === "" || leaf === "." || leaf === "..") {
      return pinned(await realpath(input));
    }
    return childStats(await realpath(win32.dirname(input)), leaf);
  }

  return { realpath, stat, lstat, open };
}
