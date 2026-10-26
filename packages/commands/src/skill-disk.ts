import { createHash } from "node:crypto";
import { close, fchmod, fstat, fsync, read, write, type Stats } from "node:fs";
import { promisify } from "node:util";
import { basename, dirname } from "node:path";
import {
  createCommandFile,
  directoryFlags,
  directoryReader,
  fileFlags,
  makeCommandDirectory,
  openCommandChild,
  openResolvedDirectory,
  readCommandLink,
  linkCommandEntry,
  removeCommandEntry,
  renameCommandEntry,
  renameCommandEntryAs,
  type OpenCommandChild,
} from "./posix.ts";
import { skillFolderLimits } from "./limits.ts";
import type { FolderFile } from "./skill-source.ts";
import { SkillError } from "./skill-errors.ts";

const closeFd = promisify(close),
  statFd = promisify(fstat),
  syncFd = promisify(fsync),
  chmodFd = promisify(fchmod);
const readFd = (fd: number, buffer: Buffer, position: number) =>
  new Promise<number>((accept, reject) =>
    read(fd, buffer, 0, buffer.length, position, (error, bytes) =>
      error ? reject(error) : accept(bytes),
    ),
  );
const writeFd = (fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
  new Promise<number>((accept, reject) =>
    write(fd, buffer, offset, length, position, (error, bytes) =>
      error ? reject(error) : accept(bytes),
    ),
  );
const chunk = 64 * 1024;
const tooLarge = () =>
  new SkillError(
    "limit",
    `This skill folder is over ${skillFolderLimits.totalBytes / 1024 / 1024} MB or has a file over ${skillFolderLimits.fileBytes / 1024 / 1024} MB.`,
  );
export interface DirectoryIdentity {
  dev: number;
  ino: number;
}
export const sameDirectory = (a: DirectoryIdentity | undefined, b: DirectoryIdentity | undefined) =>
  !!a && !!b && a.dev === b.dev && a.ino === b.ino;
/** Bytes read so far across one folder walk. */
interface Budget {
  bytes: number;
  files: number;
}

/**
 * Skill folders opened through descriptors (ADR 0103 "Containment"). The root is opened from `/`
 * one component at a time and every descendant relative to its parent, all with O_NOFOLLOW, so a
 * directory swapped for a symlink mid-operation can never redirect a read, write or delete.
 */
export class SkillDisk {
  private readonly openChild: OpenCommandChild;
  constructor(openChild: OpenCommandChild = openCommandChild) {
    this.openChild = openChild;
  }
  /** A resolved directory, or `undefined` when any component is missing or is a link. */
  async openPath(real: string): Promise<number | undefined> {
    return openResolvedDirectory(this.openChild, real).catch(() => undefined);
  }
  /**
   * Whether a resolved path is confirmed gone: its parent opens (pinned, no links) and its
   * listing has no such name. Permission errors or a link in the way are not absence.
   */
  async absent(real: string): Promise<boolean> {
    const parent = await this.openPath(dirname(real));
    if (parent === undefined) return false;
    try {
      return !(await this.names(parent)).includes(basename(real));
    } catch {
      return false;
    } finally {
      await closeFd(parent);
    }
  }
  /** A child directory that is not a link, or `undefined`. */
  async openDirectory(parent: number, name: string): Promise<number | undefined> {
    return this.openChild(parent, name, directoryFlags).catch(() => undefined);
  }
  /** Run `work` with the skill root and the skill folder pinned; both close afterwards. */
  async withFolder<T>(
    rootReal: string,
    name: string,
    work: (root: number, folder: number) => Promise<T>,
  ): Promise<T> {
    const root = await this.openPath(rootReal);
    if (root === undefined)
      throw new SkillError("read_only", "This skill's folder moved. Reload the list.");
    try {
      const folder = await this.openDirectory(root, name);
      if (folder === undefined)
        throw new SkillError("read_only", "This skill's folder moved. Reload the list.");
      try {
        return await work(root, folder);
      } finally {
        await closeFd(folder);
      }
    } finally {
      await closeFd(root);
    }
  }
  async names(directory: number): Promise<string[]> {
    const fd = await this.openChild(directory, ".", directoryFlags);
    const reader = await directoryReader(fd).catch(async (error: unknown) => {
      await closeFd(fd);
      throw error;
    });
    const names: string[] = [];
    try {
      for (let name = await reader.read(); name !== undefined; name = await reader.read()) {
        if (name === "." || name === "..") continue;
        if (names.length >= skillFolderLimits.files * 2) throw tooLarge();
        names.push(name);
      }
    } finally {
      await reader.close();
    }
    return names.toSorted();
  }
  /** A regular file's bytes, refusing links and anything over `limit`. `undefined` if absent. */
  async readFile(directory: number, name: string, limit: number): Promise<Buffer | undefined> {
    const fd = await this.openChild(directory, name, fileFlags).catch(() => undefined);
    if (fd === undefined) return undefined;
    try {
      const info = await statFd(fd);
      if (!info.isFile()) return undefined;
      if (info.size > limit) throw new SkillError("limit", "SKILL.md can be up to 256 KB.");
      const buffer = Buffer.alloc(limit + 1);
      let offset = 0;
      for (;;) {
        const count = await readFd(fd, buffer.subarray(offset), offset);
        if (!count) break;
        offset += count;
        if (offset > limit) throw new SkillError("limit", "SKILL.md can be up to 256 KB.");
      }
      return buffer.subarray(0, offset);
    } finally {
      await closeFd(fd);
    }
  }
  /** Write `bytes` to a new file (exclusive create, no links) and flush it. */
  async writeNew(directory: number, name: string, bytes: Buffer, mode: number): Promise<void> {
    const fd = await createCommandFile(directory, name).catch(() => {
      throw new SkillError("unavailable", "Couldn't write this skill. Check its permissions.");
    });
    try {
      let at = 0;
      while (at < bytes.length) {
        const count = await writeFd(fd, bytes, at, bytes.length - at, at);
        if (!count) throw new SkillError("unavailable", "Couldn't write this skill.");
        at += count;
      }
      await chmodFd(fd, mode);
      await syncFd(fd);
    } finally {
      await closeFd(fd);
    }
  }
  async rename(fromDirectory: number, from: string, toDirectory: number, to: string) {
    if (!(await renameCommandEntry(fromDirectory, from, toDirectory, to)))
      throw new SkillError("unavailable", "Couldn't move this skill's files.");
  }
  /** Move `from` to `to` in one pinned directory, only while `to` is free. */
  async move(directory: number, from: string, to: string): Promise<void> {
    if (!(await renameCommandEntryAs("noReplace", directory, from, directory, to)))
      throw new SkillError("unavailable", "Couldn't move this skill's files.");
  }
  /** Swap two entries of one pinned directory atomically: there is no moment without either. */
  async exchange(directory: number, first: string, second: string): Promise<void> {
    if (!(await renameCommandEntryAs("exchange", directory, first, directory, second)))
      throw new SkillError("unavailable", "Couldn't move this skill's files.");
  }
  /** Device and inode of an open descriptor: exactly the directory that will be acted on. */
  async identityOf(fd: number): Promise<DirectoryIdentity> {
    const info = await statFd(fd);
    return { dev: info.dev, ino: info.ino };
  }
  /** Device and inode of a child directory that isn't a link, or `undefined`. */
  async identity(parent: number, name: string): Promise<DirectoryIdentity | undefined> {
    const fd = await this.openDirectory(parent, name);
    if (fd === undefined) return undefined;
    try {
      const info = await statFd(fd);
      return { dev: info.dev, ino: info.ino };
    } finally {
      await closeFd(fd);
    }
  }
  /** A child link's stored text; `undefined` when `name` is missing or isn't a link. */
  async readLink(parent: number, name: string): Promise<string | undefined> {
    return readCommandLink(parent, name).catch(() => undefined);
  }
  /** Whether anything at all, link or not, is called `name` in the pinned directory. */
  async exists(parent: number, name: string): Promise<boolean> {
    if ((await this.readLink(parent, name)) !== undefined) return true;
    const fd = await this.openChild(parent, name, fileFlags).catch(() => undefined);
    if (fd === undefined) return false;
    await closeFd(fd);
    return true;
  }
  /** symlinkat in the pinned directory; false when `name` already exists. */
  async symlink(parent: number, target: string, name: string): Promise<boolean> {
    return linkCommandEntry(target, parent, name);
  }
  closeDirectory(fd: number): Promise<void> {
    return closeFd(fd);
  }
  /** rmdir of an empty child; a link or a different entry of that name fails. */
  async removeEmptyDirectory(parent: number, name: string): Promise<void> {
    if (!(await removeCommandEntry(parent, name, true)))
      throw new SkillError("unavailable", "Couldn't remove this skill's folder.");
  }
  async makeDirectory(parent: number, name: string): Promise<boolean> {
    return makeCommandDirectory(parent, name, 0o755);
  }
  async removeFile(directory: number, name: string): Promise<void> {
    await removeCommandEntry(directory, name, false);
  }
  /** Everything inside a pinned directory; links are removed, never followed. */
  async empty(directory: number, depth = 0): Promise<void> {
    if (depth > skillFolderLimits.depth) throw tooLarge();
    for (const name of await this.names(directory)) {
      const child = await this.openDirectory(directory, name);
      if (child !== undefined) {
        try {
          await this.empty(child, depth + 1);
        } finally {
          await closeFd(child);
        }
        if (!(await removeCommandEntry(directory, name, true)))
          throw new SkillError("unavailable", "Couldn't remove this skill's files.");
      } else if (!(await removeCommandEntry(directory, name, false)))
        throw new SkillError("unavailable", "Couldn't remove this skill's files.");
    }
  }
  /** Remove `name` from a pinned parent: a directory's contents first, a link only as itself. */
  async remove(parent: number, name: string): Promise<void> {
    const child = await this.openDirectory(parent, name);
    if (child === undefined) {
      await removeCommandEntry(parent, name, false);
      return;
    }
    try {
      await this.empty(child);
    } finally {
      await closeFd(child);
    }
    await removeCommandEntry(parent, name, true);
  }
  /**
   * Every file below a pinned directory with its SHA-256, streamed in bounded chunks. Links are
   * recorded by their text, never followed. Over the folder limits gives a `limit` error.
   */
  async walk(directory: number): Promise<Map<string, FolderFile>> {
    const files = new Map<string, FolderFile>();
    await this.visit(directory, "", 0, files, { bytes: 0, files: 0 });
    return files;
  }
  private async visit(
    directory: number,
    prefix: string,
    depth: number,
    files: Map<string, FolderFile>,
    budget: Budget,
  ): Promise<void> {
    if (depth > skillFolderLimits.depth)
      throw new SkillError("limit", "This skill folder is nested too deeply.");
    for (const name of await this.names(directory)) {
      const path = prefix ? `${prefix}/${name}` : name;
      const child = await this.openDirectory(directory, name);
      if (child !== undefined) {
        try {
          await this.visit(child, path, depth + 1, files, budget);
        } finally {
          await closeFd(child);
        }
        continue;
      }
      if (++budget.files > skillFolderLimits.files)
        throw new SkillError("limit", "This skill has too many files.");
      files.set(path, await this.fileEntry(directory, name, budget));
    }
  }
  private async fileEntry(directory: number, name: string, budget: Budget): Promise<FolderFile> {
    const fd = await this.openChild(directory, name, fileFlags).catch(() => undefined);
    if (fd === undefined) {
      const target = await readCommandLink(directory, name).catch(() => {
        throw new SkillError("unavailable", "Couldn't read this skill's files.");
      });
      return { hash: `link:${target}`, executable: false };
    }
    try {
      const info = await statFd(fd);
      if (!info.isFile()) return { hash: `special:${info.mode}`, executable: false };
      return { hash: await this.hash(fd, info, budget), executable: (info.mode & 0o111) !== 0 };
    } finally {
      await closeFd(fd);
    }
  }
  private async hash(fd: number, info: Stats, budget: Budget): Promise<string> {
    if (info.size > skillFolderLimits.fileBytes) throw tooLarge();
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(chunk);
    let size = 0;
    for (;;) {
      const count = await readFd(fd, buffer, size);
      if (!count) break;
      size += count;
      budget.bytes += count;
      if (size > skillFolderLimits.fileBytes || budget.bytes > skillFolderLimits.totalBytes)
        throw tooLarge();
      digest.update(buffer.subarray(0, count));
    }
    return digest.digest("hex");
  }
  /** Copy regular files and folders from one pinned directory into another, in chunks. */
  async copy(from: number, to: number, depth = 0): Promise<void> {
    if (depth > skillFolderLimits.depth) throw tooLarge();
    for (const name of await this.names(from)) {
      const child = await this.openDirectory(from, name);
      if (child !== undefined) {
        try {
          if (!(await this.makeDirectory(to, name)))
            throw new SkillError("update_failed", "Couldn't stage this update.");
          const target = await this.openDirectory(to, name);
          if (target === undefined)
            throw new SkillError("update_failed", "Couldn't stage this update.");
          try {
            await this.copy(child, target, depth + 1);
          } finally {
            await closeFd(target);
          }
        } finally {
          await closeFd(child);
        }
        continue;
      }
      await this.copyFile(from, to, name);
    }
  }
  private async copyFile(from: number, to: number, name: string): Promise<void> {
    const source = await this.openChild(from, name, fileFlags);
    try {
      const info = await statFd(source);
      if (!info.isFile()) throw new SkillError("update_failed", "Staged entry isn't a file.");
      const target = await createCommandFile(to, name);
      try {
        const buffer = Buffer.alloc(chunk);
        let at = 0;
        for (;;) {
          const count = await readFd(source, buffer, at);
          if (!count) break;
          let written = 0;
          while (written < count)
            written += await writeFd(target, buffer, written, count - written, at + written);
          at += count;
        }
        await chmodFd(target, (info.mode & 0o111) !== 0 ? 0o755 : 0o644);
        await syncFd(target);
      } finally {
        await closeFd(target);
      }
    } finally {
      await closeFd(source);
    }
  }
}
