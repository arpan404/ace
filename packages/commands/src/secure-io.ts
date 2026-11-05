import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isAbsolute } from "node:path";
import type { DiscoveryRoot } from "./roots.ts";
import { writeOutcomeUnknown } from "./posix-ops.ts";
import {
  closeCommandFd as closeFd,
  readCommandFd,
  statCommandFd,
  syncCommandFd,
  writeCommandFd,
  type CommandStat,
} from "./posix-calls.ts";
import {
  createCommandDirectory,
  createCommandFile,
  replaceCommandFile,
  removeCommandEntryLater,
  removeCommandEntry,
  openCommandPath,
  linkCommandFile,
  openCommandChild,
  readCommandLink,
  directoryReader,
  directoryFlags,
  fileFlags,
  type OpenCommandChild,
  type DirectoryReader,
  EntryUnavailable,
  openResolvedDirectory,
  commandCallOwner,
} from "./posix.ts";
export interface CommandFileIo {
  stat(root: DiscoveryRoot, path: string): Promise<CommandStat | undefined>;
  directory(root: DiscoveryRoot, path: string): Promise<DirectoryReader>;
  read(
    root: DiscoveryRoot,
    path: string,
  ): Promise<{ text: string; bytes: number; stat: CommandStat }>;
  /** Stops new and queued calls at once; running ones are released when they return. */
  cancel(): void;
  close(): Promise<void>;
}
/** The lane a root's calls run on: its trusted anchor. */
export const commandLaneOf = (root: DiscoveryRoot) =>
  resolve(root.trustedRoot ?? dirname(root.path));

/**
 * Roots and every descendant are opened relative to pinned handles with O_NOFOLLOW. Each call
 * opens its anchor afresh from `/` (one call on the anchor's thread), so no handle outlives the
 * call that needed it and an idle root holds no thread.
 */
export class SecureCommandIo implements CommandFileIo {
  private closed = false;
  private readonly openChild: OpenCommandChild;
  // Every call this instance makes; cancelling it never touches another instance's calls.
  private readonly owner = commandCallOwner();
  constructor(openChild: OpenCommandChild = openCommandChild) {
    this.openChild = (directory, name, flags) => openChild(directory, name, flags, this.owner);
  }
  /** A fresh handle on the anchor; starting at / avoids following a replaced ancestor. */
  private async anchor(path: string): Promise<number> {
    if (this.closed) throw new Error("Command filesystem closed");
    if (process.platform === "win32")
      return openResolvedDirectory(this.openChild, resolve(path), this.owner);
    return openCommandPath(resolve(path), resolve(path), this.owner);
  }
  private async open(root: DiscoveryRoot, path: string, flags: number): Promise<number> {
    const anchor = commandLaneOf(root);
    const tail = relative(anchor, resolve(path));
    if (tail === ".." || tail.startsWith(`..${sep}`) || tail.startsWith(sep) || tail.includes("\0"))
      throw new Error("Command escaped its trusted root");
    // A different drive is an absolute path on Windows, never a `..` one.
    if (process.platform === "win32" && isAbsolute(tail))
      throw new Error("Command escaped its trusted root");
    let parent = await this.anchor(anchor);
    try {
      const parts = tail.split(sep).filter(Boolean);
      if (parts.length > 128) throw new Error("Command path depth limit");
      for (const [index, name] of parts.slice(0, -1).entries()) {
        const child = await this.openDirectory(
          root,
          parent,
          name,
          resolve(anchor, ...parts.slice(0, index + 1)),
        );
        await closeFd(parent, this.owner);
        parent = child;
      }
      const name = parts.at(-1) ?? ".";
      try {
        return await this.openChild(parent, name, flags);
      } catch (error) {
        if (!(error instanceof EntryUnavailable)) throw error;
        return await this.openSkillLink(root, parent, name, path, flags);
      }
    } finally {
      await closeFd(parent, this.owner);
    }
  }
  private async openDirectory(
    root: DiscoveryRoot,
    parent: number,
    name: string,
    path: string,
  ): Promise<number> {
    try {
      return await this.openChild(parent, name, directoryFlags);
    } catch (error) {
      if (!(error instanceof EntryUnavailable)) throw error;
      return this.openSkillLink(root, parent, name, path, directoryFlags);
    }
  }
  private async openSkillLink(
    root: DiscoveryRoot,
    parent: number,
    name: string,
    path: string,
    flags: number,
  ): Promise<number> {
    const home = root.skillLinkHome;
    // Only immediate skill folders may link elsewhere in the registered user's home.
    if (!root.skill || !home || resolve(dirname(path)) !== resolve(root.path))
      throw new EntryUnavailable("Unavailable skill folder");
    const target = resolve(dirname(path), await readCommandLink(parent, name, this.owner));
    const tail = relative(resolve(home), target);
    if (tail === ".." || tail.startsWith(`..${sep}`) || tail.startsWith(sep))
      throw new EntryUnavailable("Skill link outside home");
    if (process.platform === "win32" && isAbsolute(tail))
      throw new EntryUnavailable("Skill link outside home");
    // Target ancestors and descendants still use O_NOFOLLOW: chains and nested links fail closed.
    return this.open({ ...root, trustedRoot: home, skillLinkHome: undefined }, target, flags);
  }
  async stat(root: DiscoveryRoot, path: string): Promise<CommandStat | undefined> {
    let fd: number;
    try {
      fd = await this.open(root, path, fileFlags);
    } catch (error) {
      if (error instanceof EntryUnavailable) return undefined;
      throw error;
    }
    try {
      return await statCommandFd(fd, this.owner);
    } finally {
      await closeFd(fd, this.owner);
    }
  }
  async directory(root: DiscoveryRoot, path: string): Promise<DirectoryReader> {
    // The reader takes the descriptor in every case, including when it fails.
    return directoryReader(await this.open(root, path, directoryFlags), this.owner);
  }
  async read(
    root: DiscoveryRoot,
    path: string,
  ): Promise<{ text: string; bytes: number; stat: CommandStat }> {
    const fd = await this.open(root, path, fileFlags);
    try {
      const stat = await statCommandFd(fd, this.owner);
      if (!stat.isFile()) throw new Error("Not a regular command file");
      const buffer = Buffer.alloc(65537);
      let offset = 0;
      while (offset < buffer.length) {
        const length = buffer.length - offset;
        const count = await readCommandFd(fd, buffer, offset, length, offset, this.owner);
        if (!count) break;
        offset += count;
      }
      if (offset > 65536) throw new Error("Command exceeds 64 KiB");
      return { text: buffer.subarray(0, offset).toString("utf8"), bytes: offset, stat };
    } finally {
      await closeFd(fd, this.owner);
    }
  }
  /** Atomic prompt replacement beneath the same pinned root used by discovery. */
  async writePrompt(
    root: DiscoveryRoot,
    path: string,
    text: string,
    expected: string | null,
    temporary: string,
  ): Promise<void> {
    if (Buffer.byteLength(text) > 65536) throw new Error("prompt_limit");
    const anchor = resolve(root.trustedRoot ?? dirname(root.path));
    const tail = relative(anchor, resolve(path));
    if (tail.startsWith("..") || tail.startsWith(sep) || tail.includes("\0"))
      throw new Error("prompt_unavailable");
    if (process.platform === "win32" && isAbsolute(tail)) throw new Error("prompt_unavailable");
    const parts = tail.split(sep).filter(Boolean);
    if (parts.length > 128 || !/^[a-zA-Z0-9.-]+$/.test(temporary))
      throw new Error("prompt_unavailable");
    let parent = await this.anchor(anchor);
    let temp: number | undefined;
    // Whether the temporary file may exist: created, or its create may still land.
    let made = false;
    try {
      for (const name of parts.slice(0, -1)) {
        await createCommandDirectory(parent, name, this.owner);
        const next = await this.openChild(parent, name, directoryFlags);
        await closeFd(parent, this.owner);
        parent = next;
      }
      const name = parts.at(-1);
      if (!name) throw new Error("prompt_unavailable");
      // Compare via the pinned root, never follow a supplied path.
      let current: string | null = null;
      const stat = await this.stat(root, path);
      if (stat)
        current = createHash("sha256")
          .update((await this.read(root, path)).text)
          .digest("hex");
      if (current !== expected) throw new Error("prompt_conflict");
      temp = await createCommandFile(parent, temporary, this.owner).catch((error: unknown) => {
        if (writeOutcomeUnknown(error)) made = true;
        throw error;
      });
      made = true;
      const bytes = Buffer.from(text);
      let at = 0;
      while (at < bytes.length) {
        const count = await writeCommandFd(temp, bytes, at, bytes.length - at, at, this.owner);
        if (!count) throw new Error("prompt_unavailable");
        at += count;
      }
      await syncCommandFd(temp, this.owner);
      await closeFd(temp, this.owner);
      temp = undefined;
      if (expected === null) await linkCommandFile(parent, temporary, name, this.owner);
      else {
        const latest = createHash("sha256")
          .update((await this.read(root, path)).text)
          .digest("hex");
        if (latest !== expected) throw new Error("prompt_conflict");
        await replaceCommandFile(parent, temporary, name, this.owner);
      }
    } finally {
      // Closes wait for any call still using the descriptor. The temporary file goes once no
      // earlier change on the root can still land, and the folder closes after that; neither
      // can hide the save's own error.
      if (temp !== undefined) await closeFd(temp, this.owner);
      // The temporary file goes now. If that is refused (an earlier change may still land) or
      // its folder's thread is gone, it goes once the root has settled, reopened by path.
      if (
        made &&
        !(await removeCommandEntry(parent, temporary, false).then(
          () => true,
          () => false,
        ))
      )
        removeCommandEntryLater(anchor, join(anchor, ...parts.slice(0, -1)), temporary);
      await closeFd(parent, this.owner);
    }
  }
  cancel(): void {
    this.closed = true;
    this.owner.cancel();
  }
  /** Holds no handles between calls, so there is nothing to wait for. */
  async close(): Promise<void> {
    this.cancel();
  }
}
