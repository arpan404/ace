import { closeSync, constants, readSync } from "node:fs";
import { Descriptor, openAt, statWindowsFd, windowsFdId, windowsIdAt } from "./descriptor.ts";

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
 *
 * A held folder can still be moved, even out of the project, and its handle follows it. Windows
 * refuses to move a folder while any handle under it is open, so holding a folder pins every
 * folder above it: its parent's place is checked once when it's opened, and its own place is
 * checked after each file opens in it, when the open file pins it too.
 */
export class PassDirectories {
  private readonly root: Descriptor;
  private readonly limit: number;
  /** Map order is recency: the first key is evicted first. */
  private readonly held = new Map<string, { handle: Descriptor; id: string }>();
  private readonly closing: Promise<void>[] = [];
  private closed = false;
  constructor(root: Descriptor, limit = 256) {
    this.root = root;
    this.limit = limit;
  }
  /** The held directory for a "/"-separated relative path ("" is the root). */
  private directory(path: string): number {
    if (this.closed) throw Object.assign(new Error("The search pass has ended"), { code: "EBADF" });
    if (!path) return this.root.fd;
    const cached = this.held.get(path);
    if (cached) {
      this.held.delete(path);
      this.held.set(path, cached);
      return cached.handle.fd;
    }
    const slash = path.lastIndexOf("/");
    const parentPath = slash < 0 ? "" : path.slice(0, slash);
    const parent = this.directory(parentPath);
    const opened = openAt(parent, path.slice(slash + 1), constants.O_RDONLY);
    let id: string;
    try {
      if (!statWindowsFd(opened.fd).isDirectory())
        throw Object.assign(new Error("Not a directory"), { code: "ENOTDIR" });
      // The open folder now pins its parent, which may have moved since it was checked.
      this.inPlace(parentPath);
      id = windowsFdId(opened.fd);
    } catch (error) {
      this.closing.push(opened.close().catch(() => {}));
      throw error;
    }
    this.held.set(path, { handle: opened, id });
    if (this.held.size > this.limit) {
      const [oldest, entry] = this.held.entries().next().value ?? [];
      if (oldest !== undefined && entry) {
        this.held.delete(oldest);
        this.closing.push(entry.handle.close().catch(() => {}));
      }
    }
    return opened.fd;
  }
  /** Throws unless the folder at `path` is still that name in its held parent. */
  private inPlace(path: string): void {
    if (!path) return;
    const id = this.held.get(path)?.id;
    if (!id) throw Object.assign(new Error("Folder is not held"), { code: "ENOENT" });
    const slash = path.lastIndexOf("/");
    const parent = this.directory(slash < 0 ? "" : path.slice(0, slash));
    if (windowsIdAt(parent, path.slice(slash + 1)) !== id)
      throw Object.assign(new Error("Folder moved during the search"), { code: "ESTALE" });
  }
  /** Opens a relative file path read-only; a link anywhere on it fails with ELOOP. */
  file(path: string): Descriptor {
    const slash = path.lastIndexOf("/");
    const parentPath = slash < 0 ? "" : path.slice(0, slash);
    const opened = openAt(this.directory(parentPath), path.slice(slash + 1), constants.O_RDONLY);
    try {
      // The open file pins its folder, so a folder found in place now stays there.
      this.inPlace(parentPath);
    } catch (error) {
      this.closing.push(opened.close().catch(() => {}));
      throw error;
    }
    return opened;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const handles = [this.root, ...[...this.held.values()].map((entry) => entry.handle)];
    this.held.clear();
    await Promise.all([
      ...this.closing,
      ...handles.map((handle) => handle.close().catch(() => {})),
    ]);
  }
}
