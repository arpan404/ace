import { constants, fstatSync, closeSync, type Stats } from "node:fs";
import {
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
  close(): Promise<void> {
    return this.handle.close();
  }
}
