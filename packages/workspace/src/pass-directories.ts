import { closeSync, constants, readSync } from "node:fs";
import { Descriptor, openAt, statWindowsFd } from "./descriptor.ts";

/**
 * Win32: a pass file whose bytes are on this disk. Each async read or close costs a thread-pool
 * round trip (~65 µs on Windows), several times the read itself, so these run inline; reads
 * stay bounded by the caller's 64 KiB chunks.
 */
export class LocalFileDescriptor extends Descriptor {
  override read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }> {
    try {
      return Promise.resolve({ bytesRead: readSync(this.fd, buffer, offset, length, position) });
    } catch (error) {
      return Promise.reject(error);
    }
  }
  override close(): Promise<void> {
    try {
      closeSync(this.fd);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

/**
 * Win32: directory handles held for one search pass, so a file opens with one native call
 * relative to its parent instead of a walk from the drive root.
 *
 * Every handle comes from the add-on's openAt relative to an already-held parent, starting at
 * the verified root handle; openAt refuses a junction or symlink as the opened name, so each
 * held chain is link-free. The cache is bounded and released when the pass ends.
 */
export class PassDirectories {
  private readonly root: Descriptor;
  private readonly limit: number;
  /** Map order is recency: the first key is evicted first. */
  private readonly held = new Map<string, Descriptor>();
  private readonly closing: Promise<void>[] = [];
  constructor(root: Descriptor, limit = 256) {
    this.root = root;
    this.limit = limit;
  }
  /** The held directory for a "/"-separated relative path ("" is the root). */
  private directory(path: string): number {
    if (!path) return this.root.fd;
    const cached = this.held.get(path);
    if (cached) {
      this.held.delete(path);
      this.held.set(path, cached);
      return cached.fd;
    }
    const slash = path.lastIndexOf("/");
    const parent = this.directory(slash < 0 ? "" : path.slice(0, slash));
    const opened = openAt(parent, path.slice(slash + 1), constants.O_RDONLY);
    try {
      if (!statWindowsFd(opened.fd).isDirectory())
        throw Object.assign(new Error("Not a directory"), { code: "ENOTDIR" });
    } catch (error) {
      this.closing.push(opened.close().catch(() => {}));
      throw error;
    }
    this.held.set(path, opened);
    if (this.held.size > this.limit) {
      const [oldest, handle] = this.held.entries().next().value ?? [];
      if (oldest !== undefined && handle) {
        this.held.delete(oldest);
        this.closing.push(handle.close().catch(() => {}));
      }
    }
    return opened.fd;
  }
  /** Opens a relative file path read-only; a link anywhere on it fails with ELOOP. */
  file(path: string): Descriptor {
    const slash = path.lastIndexOf("/");
    const parent = this.directory(slash < 0 ? "" : path.slice(0, slash));
    return openAt(parent, path.slice(slash + 1), constants.O_RDONLY);
  }
  async close(): Promise<void> {
    const handles = [this.root, ...this.held.values()];
    this.held.clear();
    await Promise.all([
      ...this.closing,
      ...handles.map((handle) => handle.close().catch(() => {})),
    ]);
  }
}
