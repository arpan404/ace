import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { maxParcelBytes } from "@ace/protocol";

/** A parcel's bytes could not be staged, read or placed; `message` is safe to show the agent. */
export class ParcelFileError extends Error {
  readonly code: "not_found" | "invalid" | "too_large" | "exists" | "corrupt";
  constructor(code: ParcelFileError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const BUFFER = 256 * 1024;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && !rel.includes(`..${sep}`);
}

/**
 * Parcel bytes on disk (ADR 0182), under `<data>/parcels` (mode 0700): `out/<id>` is the
 * sender's immutable snapshot, `in/<id>.part` a parcel arriving, `in/<id>/<name>` one verified
 * and kept read-only (0400). Names come only from validated parcel facts.
 */
export class ParcelFiles {
  private root: string;
  constructor(dataDir: string) {
    this.root = join(dataDir, "parcels");
  }
  private async dir(kind: "out" | "in"): Promise<string> {
    const path = join(this.root, kind);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    return path;
  }
  /**
   * Copies a regular file inside `project` (no link at its last step, never one leading out of
   * the project) or the given text into the snapshot, hashing as it goes.
   */
  async stage(
    parcelId: string,
    source: { project: string; path: string } | { text: string },
  ): Promise<{ size: number; sha256: string }> {
    const target = join(await this.dir("out"), parcelId);
    const hash = createHash("sha256");
    const output = await open(target, "wx", 0o600);
    let size = 0;
    try {
      if ("text" in source) {
        const bytes = Buffer.from(source.text, "utf8");
        hash.update(bytes);
        await output.write(bytes);
        size = bytes.length;
      } else {
        const root = await realpath(source.project);
        const asked = join(root, source.path);
        let resolved: string;
        try {
          resolved = await realpath(asked);
        } catch {
          throw new ParcelFileError("not_found", `No file at ${source.path} in this project.`);
        }
        if (!inside(root, resolved))
          throw new ParcelFileError("invalid", "path must name a file inside this project.");
        // Non-blocking, so a named pipe can't hold the open; its type is refused just below.
        const input = await open(
          resolved,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        ).catch(() => {
          throw new ParcelFileError("not_found", `Couldn't open ${source.path}.`);
        });
        try {
          const facts = await input.stat();
          if (!facts.isFile())
            throw new ParcelFileError("invalid", `${source.path} isn't a regular file.`);
          if (facts.size > maxParcelBytes)
            throw new ParcelFileError("too_large", "A parcel holds at most 1 GiB.");
          const buffer = Buffer.allocUnsafe(BUFFER);
          for (;;) {
            const { bytesRead } = await input.read(buffer, 0, BUFFER, null);
            if (bytesRead === 0) break;
            size += bytesRead;
            if (size > maxParcelBytes)
              throw new ParcelFileError("too_large", "A parcel holds at most 1 GiB.");
            hash.update(buffer.subarray(0, bytesRead));
            await output.write(buffer, 0, bytesRead);
          }
        } finally {
          await input.close();
        }
      }
      await output.sync();
    } catch (error) {
      await output.close().catch(() => {});
      await rm(target, { force: true });
      throw error;
    }
    await output.close();
    return { size, sha256: hash.digest("hex") };
  }
  /** `length` bytes of the snapshot from `offset`. */
  async readOut(parcelId: string, offset: number, length: number): Promise<Buffer> {
    const file = await open(join(this.root, "out", parcelId), "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  }
  async removeOut(parcelId: string): Promise<void> {
    await rm(join(this.root, "out", parcelId), { force: true });
  }
  private part(parcelId: string): string {
    return join(this.root, "in", `${parcelId}.part`);
  }
  /** Bytes of an arriving parcel on disk now. */
  async heldOnDisk(parcelId: string): Promise<number> {
    try {
      return (await stat(this.part(parcelId))).size;
    } catch {
      return 0;
    }
  }
  /** Writes `bytes` at `offset`, dropping anything past it first (a crash's partial write). */
  async append(parcelId: string, offset: number, bytes: Buffer): Promise<void> {
    await this.dir("in");
    const file = await open(this.part(parcelId), constants.O_WRONLY | constants.O_CREAT, 0o600);
    try {
      await file.truncate(offset);
      await file.write(bytes, 0, bytes.length, offset);
    } finally {
      await file.close();
    }
  }
  /**
   * Checks the whole arriving file against `sha256` and places it read-only under its name.
   * A mismatch removes it, so the sender starts over.
   */
  async finish(parcelId: string, name: string, size: number, sha256: string): Promise<string> {
    const part = this.part(parcelId);
    await this.dir("in");
    // An empty parcel never had a chunk written: its file is made here.
    const file = await open(part, constants.O_RDWR | constants.O_CREAT, 0o600);
    const hash = createHash("sha256");
    let total = 0;
    try {
      await file.sync();
      const buffer = Buffer.allocUnsafe(BUFFER);
      for (;;) {
        const { bytesRead } = await file.read(buffer, 0, BUFFER, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      await file.close();
    }
    if (total !== size || hash.digest("hex") !== sha256) {
      await rm(part, { force: true });
      throw new ParcelFileError("corrupt", "The parcel's bytes didn't match its SHA-256.");
    }
    const folder = join(this.root, "in", parcelId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const placed = join(folder, name);
    await chmod(part, 0o400);
    await rename(part, placed);
    return placed;
  }
  /** Where a delivered parcel is kept. */
  placed(parcelId: string, name: string): string {
    return join(this.root, "in", parcelId, name);
  }
  async removeIn(parcelId: string): Promise<void> {
    await rm(this.part(parcelId), { force: true });
    await rm(join(this.root, "in", parcelId), { recursive: true, force: true });
  }
  /**
   * Copies a delivered parcel to `relativePath` inside `project`, making folders as needed,
   * never replacing a file and never writing through a link out of the project.
   */
  async saveAs(
    parcelId: string,
    name: string,
    project: string,
    relativePath: string,
  ): Promise<string> {
    const root = await realpath(project);
    // Folder by folder, each checked to resolve inside the project before the next is made, so
    // a link in the path can't get anything made outside it.
    const parts = relativePath.split(sep);
    const fileName = parts.pop() ?? "";
    let parent = root;
    for (const part of parts) {
      const next = join(parent, part);
      await mkdir(next).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      });
      parent = await realpath(next);
      if (!inside(root, parent))
        throw new ParcelFileError("invalid", "saveAs must stay inside this project.");
    }
    const final = join(parent, fileName);
    const input = await open(this.placed(parcelId, name), "r");
    let output;
    try {
      output = await open(
        final,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      );
    } catch (error) {
      await input.close();
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        throw new ParcelFileError("exists", `${relativePath} already exists; pick a new path.`);
      throw error;
    }
    try {
      const buffer = Buffer.allocUnsafe(BUFFER);
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, BUFFER, null);
        if (bytesRead === 0) break;
        await output.write(buffer, 0, bytesRead);
      }
      await output.sync();
    } finally {
      await input.close();
      await output.close();
    }
    return final;
  }
}
