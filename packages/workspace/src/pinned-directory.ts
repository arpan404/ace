import { dirname, basename, join } from "node:path";
import {
  constants,
  fstatSync,
  closeSync,
  readSync,
  writeSync,
  fsyncSync,
  lstatSync,
  realpathSync,
  type Stats,
} from "node:fs";
import {
  renameAt,
  unlinkAt,
  openRoot,
  openAt,
  mkdirAt,
  descriptorNames,
  statAt,
  type Descriptor,
} from "./descriptor.ts";

/** Own a directory inode, with descendant operations relative to its descriptor. */
export class PinnedDirectory {
  private handle: Descriptor;
  private identity: Stats;
  private constructor(handle: Descriptor) {
    this.handle = handle;
    this.identity = fstatSync(handle.fd);
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
  stat(): Stats {
    return fstatSync(this.fd);
  }
  matches(canonical: string): boolean {
    const current = openRoot(canonical);
    try {
      const info = fstatSync(current.fd);
      return info.dev === this.identity.dev && info.ino === this.identity.ino;
    } finally {
      closeSync(current.fd);
    }
  }
  child(name: string): PinnedDirectory {
    const handle = openAt(this.fd, name, constants.O_RDONLY | constants.O_DIRECTORY);
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
  metadata(name: string) {
    return statAt(this.fd, name);
  }
  async writeExclusive(name: string, text: string): Promise<void> {
    const file = openAt(this.fd, name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try {
      await file.write(Buffer.from(text));
    } finally {
      await file.close();
    }
  }
  /** Bounded regular-file read; neither FIFOs nor symlinks can be followed. */
  readText(name: string, limit: number, owner?: number): string {
    const file = openAt(this.fd, name, constants.O_RDONLY);
    try {
      const info = fstatSync(file.fd);
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
      return bytes.subarray(0, length).toString("utf8");
    } finally {
      closeSync(file.fd);
    }
  }
  createExclusive(name: string): number {
    return openAt(this.fd, name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL).fd;
  }
  publish(name: string, text: string): void {
    const temporary = name + ".pending";
    const fd = this.createExclusive(temporary);
    try {
      const bytes = Buffer.from(text);
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!written) throw new Error("Short marker write");
        offset += written;
      }
      fsyncSync(fd);
      // The caller owns selection's exclusive parent lock. Never replace an existing marker.
      try {
        this.metadata(name);
        throw new Error(`Refusing to replace ${name}`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      renameAt(this.fd, temporary, name);
      fsyncSync(this.fd);
    } finally {
      closeSync(fd);
      this.removeTemporary(temporary);
    }
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
  closeSync(): void {
    closeSync(this.fd);
  }
  close(): Promise<void> {
    return this.handle.close();
  }
}
