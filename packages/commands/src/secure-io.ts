import { createHash } from "node:crypto";
import { fstat, read, close, write, fsync } from "node:fs";
import { promisify } from "node:util";
import { dirname, relative, resolve, sep } from "node:path";
import type { Stats } from "node:fs";
import type { DiscoveryRoot } from "./roots.ts";
import {
  createCommandDirectory,
  createCommandFile,
  replaceCommandFile,
  removeCommandFile,
  linkCommandFile,
  openCommandChild,
  directoryReader,
  directoryFlags,
  fileFlags,
  type OpenCommandChild,
  type DirectoryReader,
  EntryUnavailable,
} from "./posix.ts";
const statFd = promisify(fstat),
  closeFd = promisify(close);
export interface CommandFileIo {
  stat(root: DiscoveryRoot, path: string): Promise<Stats | undefined>;
  directory(root: DiscoveryRoot, path: string): Promise<DirectoryReader>;
  read(root: DiscoveryRoot, path: string): Promise<{ text: string; bytes: number; stat: Stats }>;
  close(): Promise<void>;
}
/** Roots and every descendant are opened relative to pinned descriptors with O_NOFOLLOW. */
export class SecureCommandIo implements CommandFileIo {
  private readonly anchors = new Map<string, Promise<number>>();
  private closed = false;
  private readonly openChild: OpenCommandChild;
  constructor(openChild: OpenCommandChild = openCommandChild) {
    this.openChild = openChild;
  }
  private async anchor(path: string): Promise<number> {
    if (this.closed) throw new Error("Command filesystem closed");
    const cached = this.anchors.get(path);
    if (cached !== undefined) return cached;
    if (this.anchors.size >= 32) throw new Error("Trusted root descriptor limit");
    const opening = this.openAnchor(path).catch((error: unknown) => {
      this.anchors.delete(path);
      throw error;
    });
    this.anchors.set(path, opening);
    return opening;
  }
  private async openAnchor(path: string): Promise<number> {
    // Starting at / avoids following even a replaced ancestor of the registered root.
    let fd = await this.openChild(-100, "/", directoryFlags);
    try {
      const parts = path.split(sep).filter(Boolean);
      if (parts.length > 128) throw new Error("Trusted root depth limit");
      for (const name of parts) {
        const child = await this.openChild(fd, name, directoryFlags);
        await closeFd(fd);
        fd = child;
      }
      return fd;
    } catch (error) {
      await closeFd(fd);
      throw error;
    }
  }
  private async open(root: DiscoveryRoot, path: string, flags: number): Promise<number> {
    const anchor = resolve(root.trustedRoot ?? dirname(root.path));
    const tail = relative(anchor, resolve(path));
    if (tail === ".." || tail.startsWith(`..${sep}`) || tail.startsWith(sep) || tail.includes("\0"))
      throw new Error("Command escaped its trusted root");
    let parent = await this.openChild(await this.anchor(anchor), ".", directoryFlags);
    try {
      const parts = tail.split(sep).filter(Boolean);
      if (parts.length > 128) throw new Error("Command path depth limit");
      for (const name of parts.slice(0, -1)) {
        const child = await this.openChild(parent, name, directoryFlags);
        await closeFd(parent);
        parent = child;
      }
      return await this.openChild(parent, parts.at(-1) ?? ".", flags);
    } finally {
      await closeFd(parent);
    }
  }
  async stat(root: DiscoveryRoot, path: string): Promise<Stats | undefined> {
    let fd: number;
    try {
      fd = await this.open(root, path, fileFlags);
    } catch (error) {
      if (error instanceof EntryUnavailable) return undefined;
      throw error;
    }
    try {
      return await statFd(fd);
    } finally {
      await closeFd(fd);
    }
  }
  async directory(root: DiscoveryRoot, path: string): Promise<DirectoryReader> {
    const fd = await this.open(root, path, directoryFlags);
    try {
      return await directoryReader(fd);
    } catch (error) {
      await closeFd(fd);
      throw error;
    }
  }
  async read(
    root: DiscoveryRoot,
    path: string,
  ): Promise<{ text: string; bytes: number; stat: Stats }> {
    const fd = await this.open(root, path, fileFlags);
    try {
      const stat = await statFd(fd);
      if (!stat.isFile()) throw new Error("Not a regular command file");
      const buffer = Buffer.alloc(65537);
      let offset = 0;
      while (offset < buffer.length) {
        const count = await new Promise<number>((accept, reject) =>
          read(fd, buffer, offset, buffer.length - offset, offset, (error, bytes) =>
            error ? reject(error) : accept(bytes),
          ),
        );
        if (!count) break;
        offset += count;
      }
      if (offset > 65536) throw new Error("Command exceeds 64 KiB");
      return { text: buffer.subarray(0, offset).toString("utf8"), bytes: offset, stat };
    } finally {
      await closeFd(fd);
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
    const parts = tail.split(sep).filter(Boolean);
    if (parts.length > 128 || !/^[a-zA-Z0-9.-]+$/.test(temporary))
      throw new Error("prompt_unavailable");
    let parent = await this.openChild(await this.anchor(anchor), ".", directoryFlags);
    let temp: number | undefined;
    try {
      for (const name of parts.slice(0, -1)) {
        await createCommandDirectory(parent, name);
        const next = await this.openChild(parent, name, directoryFlags);
        await closeFd(parent);
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
      temp = await createCommandFile(parent, temporary);
      const bytes = Buffer.from(text);
      let at = 0;
      while (at < bytes.length) {
        const count = await new Promise<number>((accept, reject) =>
          write(temp ?? -1, bytes, at, bytes.length - at, at, (error, written) =>
            error ? reject(error) : accept(written),
          ),
        );
        if (!count) throw new Error("prompt_unavailable");
        at += count;
      }
      await promisify(fsync)(temp);
      await closeFd(temp);
      temp = undefined;
      if (expected === null) await linkCommandFile(parent, temporary, name);
      else {
        const latest = createHash("sha256")
          .update((await this.read(root, path)).text)
          .digest("hex");
        if (latest !== expected) throw new Error("prompt_conflict");
        await replaceCommandFile(parent, temporary, name);
      }
    } finally {
      if (temp !== undefined) await closeFd(temp);
      await removeCommandFile(parent, temporary);
      await closeFd(parent);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    const descriptors = await Promise.allSettled(this.anchors.values());
    for (const descriptor of descriptors)
      if (descriptor.status === "fulfilled") await closeFd(descriptor.value);
    this.anchors.clear();
  }
}
