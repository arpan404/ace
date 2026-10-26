import { dirname, basename, join } from "node:path";
import { closeSync, readSync, writeSync, fsyncSync, lstatSync, realpathSync } from "node:fs";
import { sameFile, type FileIdentity, type IdentifiedStats } from "./file-identity.ts";
import {
  renameAt,
  removeDirectoryAt,
  unlinkAt,
  openRoot,
  openDirectoryAt,
  openFileAt,
  createFileAt,
  mkdirAt,
  descriptorNames,
  statAt,
  symlinkAt,
  type Descriptor,
} from "./descriptor.ts";

export { sameFile, type FileIdentity, type IdentifiedStats } from "./file-identity.ts";

/** Own a directory inode, with descendant operations relative to its descriptor. */
export class PinnedDirectory {
  private handle: Descriptor;
  private identity: FileIdentity;
  private constructor(handle: Descriptor) {
    this.handle = handle;
    this.identity = handle.statSync().identity;
  }
  static open(canonical: string): PinnedDirectory {
    const handle = openRoot(canonical);
    try {
      return new PinnedDirectory(handle);
    } catch (error) {
      closeSync(handle.fd);
      throw error;
    }
  }
  /** Canonicalize ancestors outside a supplied filesystem root (e.g. macOS /var).
   * The root itself and every descendant remain no-follow boundaries.
   */
  static atBoundary(path: string): PinnedDirectory {
    const canonical = join(realpathSync(dirname(path)), basename(path));
    if (lstatSync(canonical).isSymbolicLink())
      throw new Error(`Refusing symbolic-link root: ${path}`);
    return PinnedDirectory.open(canonical);
  }
  matchesBoundary(path: string): boolean {
    const canonical = join(realpathSync(dirname(path)), basename(path));
    if (lstatSync(canonical).isSymbolicLink())
      throw new Error(`Refusing symbolic-link root: ${path}`);
    return this.matches(canonical);
  }
  get fd(): number {
    return this.handle.fd;
  }
  stat(): IdentifiedStats {
    return this.handle.statSync();
  }
  matches(canonical: string): boolean {
    const current = openRoot(canonical);
    try {
      return sameFile(current.statSync().identity, this.identity);
    } finally {
      closeSync(current.fd);
    }
  }
  child(name: string): PinnedDirectory {
    const handle = openDirectoryAt(this.fd, name);
    try {
      return new PinnedDirectory(handle);
    } catch (error) {
      closeSync(handle.fd);
      throw error;
    }
  }
  mkdir(name: string): PinnedDirectory {
    mkdirAt(this.fd, name);
    return this.child(name);
  }
  names(): string[] {
    return descriptorNames(this.fd);
  }
  empty(): boolean {
    try {
      return descriptorNames(this.fd, 1).length === 0;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "LIMIT_EXCEEDED")
        return false;
      throw error;
    }
  }
  /** Regular-file identity through a no-follow descriptor, including change timestamps. */
  fileMetadata(name: string): IdentifiedStats {
    const file = openFileAt(this.fd, name);
    try {
      const info = file.statSync();
      if (!info.isFile()) throw new Error("Expected a regular file");
      return info;
    } finally {
      closeSync(file.fd);
    }
  }
  metadata(name: string) {
    return statAt(this.fd, name);
  }
  async writeExclusive(name: string, text: string): Promise<void> {
    const file = createFileAt(this.fd, name);
    try {
      await file.write(Buffer.from(text));
    } finally {
      await file.close();
    }
  }
  /** Bounded regular-file read; neither FIFOs nor symlinks can be followed. */
  readText(name: string, limit: number, owner?: number): string {
    return this.readBytes(name, limit, owner).toString("utf8");
  }
  /** Bounded regular-file bytes through the pinned directory, without following symlinks. */
  readBytes(name: string, limit: number, owner?: number): Buffer {
    const file = openFileAt(this.fd, name);
    try {
      const info = file.statSync();
      if (
        !info.isFile() ||
        info.size > limit ||
        (owner !== undefined && (info.uid !== owner || info.nlink > 1 || (info.mode & 0o077) !== 0))
      )
        throw new Error(
          `Refusing ${name}: expected a bounded regular file owned by the home owner`,
        );
      // The name can be unlinked after openat but before fstat. Never return
      // removed private-file contents; report absence so lock contenders retry.
      if (owner !== undefined && info.nlink === 0)
        throw Object.assign(new Error(`${name} was removed during read`), { code: "ENOENT" });
      const bytes = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(file.fd, bytes, length, bytes.length - length, length);
        if (!count) break;
        length += count;
      }
      if (length > limit) throw new Error(`${name} exceeds its read limit`);
      return bytes.subarray(0, length);
    } finally {
      closeSync(file.fd);
    }
  }
  /** Read-only descriptor for a child; a symlink of that name is never followed. */
  openRead(name: string): number {
    return openFileAt(this.fd, name).fd;
  }
  /** Like openRead, with the identity and metadata observed through that same descriptor. */
  openReadIdentified(name: string): { fd: number; info: IdentifiedStats } {
    const file = openFileAt(this.fd, name);
    try {
      return { fd: file.fd, info: file.statSync() };
    } catch (error) {
      closeSync(file.fd);
      throw error;
    }
  }
  /** Stores `target` as a link's text; the link is created inside this directory only. */
  symlink(target: string, name: string): void {
    symlinkAt(this.fd, target, name);
  }
  createExclusive(name: string): number {
    return createFileAt(this.fd, name).fd;
  }
  private stage(fd: number, text: string): void {
    const bytes = Buffer.from(text);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!written) throw new Error("Short marker write");
      offset += written;
    }
    fsyncSync(fd);
  }
  /** Atomically replaces a private file. Neither name is followed if it is a symlink. */
  replace(name: string, text: string): void {
    const temporary = name + ".pending";
    this.removeTemporary(temporary);
    const fd = this.createExclusive(temporary);
    try {
      this.stage(fd, text);
      renameAt(this.fd, temporary, name);
      this.syncPublication();
    } finally {
      closeSync(fd);
      this.removeTemporary(temporary);
    }
  }
  publish(name: string, text: string): void {
    const temporary = name + ".pending";
    const fd = this.createExclusive(temporary);
    try {
      this.stage(fd, text);
      // The caller owns selection's exclusive parent lock. Never replace an existing marker.
      try {
        this.metadata(name);
        throw new Error(`Refusing to replace ${name}`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      renameAt(this.fd, temporary, name);
      this.syncPublication();
    } finally {
      closeSync(fd);
      this.removeTemporary(temporary);
    }
  }
  private syncPublication(): void {
    // Windows publication flushes the staged data handle before the relative
    // rename. Directory fsync is a POSIX durability fence; it is not supported
    // by these Windows directory handles. No power-loss guarantee is made for
    // the Windows rename. See research/windows-workspace-backend.md.
    if (process.platform !== "win32") fsyncSync(this.fd);
  }
  private removeTemporary(name: string): void {
    try {
      unlinkAt(this.fd, name);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  unlink(name: string): void {
    unlinkAt(this.fd, name);
  }
  removeDirectory(name: string): void {
    removeDirectoryAt(this.fd, name);
  }
  closeSync(): void {
    closeSync(this.fd);
  }
  close(): Promise<void> {
    return this.handle.close();
  }
}
