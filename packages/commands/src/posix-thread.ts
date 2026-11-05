import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  writeSync,
  type Stats,
} from "node:fs";
import { cString, readCString } from "@ace/provider-kit/bun-ffi";
import { openAt } from "@ace/workspace/descriptor";
import { directoryFlags } from "./posix-flags.ts";
import { posixBindings } from "./posix-native.ts";
import type { PosixOperation, PosixStat, PosixValue } from "./posix-wire.ts";

// Public dirent ABIs: Linux 64-bit d_name at 19; Darwin inode64 at 21.
const nameOffset = process.platform === "darwin" ? 21 : 19;

function integerResult(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error("Native call returned a non-integer");
  return value;
}
const statFields = ({ dev, ino, mode, size, mtimeMs, ctimeMs }: Stats): PosixStat => ({
  dev,
  ino,
  mode,
  size,
  mtimeMs,
  ctimeMs,
});

/**
 * One worker's descriptors, by handle. Descriptor numbers never leave
 * this thread: callers name handles, which are never reused, and only this thread closes what it
 * opened. A stuck call blocks this thread only; `release` then closes everything it still owns.
 */
export class PosixThread {
  private readonly fds = new Map<number, number>();

  /** Closes every descriptor this thread still owns. */
  release(): void {
    const c = posixBindings();
    for (const fd of this.fds.values()) c.close(fd);
    this.fds.clear();
  }

  private fd(handle: number): number {
    if (handle === -100) return -100;
    const fd = this.fds.get(handle);
    if (fd === undefined) throw new Error("Unknown command handle");
    return fd;
  }
  /** Stores `fd` under `handle` and answers what it is (its identity), or -1 if it failed. */
  private keep(handle: number, fd: number): PosixStat | -1 {
    if (fd < 0) return -1;
    this.fds.set(handle, fd);
    return statFields(fstatSync(fd));
  }

  run(operation: PosixOperation): PosixValue {
    const c = posixBindings();
    switch (operation.op) {
      case "open":
        // Without O_CREAT, openat reads no mode, so its variadic tail is never passed.
        return this.keep(
          operation.handle,
          integerResult(
            c.openat(this.fd(operation.directory), cString(operation.name), operation.flags),
          ),
        );
      case "create":
        // openat with O_CREAT takes its mode as a variadic argument, which bun:ffi cannot pass
        // (and Apple's arm64 ABI passes on the stack). @ace/workspace's add-on creates it, 0600.
        try {
          const flags = operation.flags | constants.O_CREAT;
          return this.keep(
            operation.handle,
            openAt(this.fd(operation.directory), operation.name, flags).fd,
          );
        } catch {
          return -1;
        }
      case "openPath":
        return this.keep(operation.handle, this.walk(operation.path));
      case "listDirectory": {
        // The descriptor is this call's: the stream takes it, and closing the stream closes it.
        const fd = this.fd(operation.fd);
        this.fds.delete(operation.fd);
        let stream: unknown;
        try {
          stream = c.fdopendir(fd);
        } finally {
          if (typeof stream !== "number") closeSync(fd);
        }
        if (typeof stream !== "number") return null;
        try {
          // `.` and `..` aren't entries: up to `limit` real names, and whether any were left.
          const names: string[] = [];
          for (;;) {
            const entry: unknown = c.readdir(stream);
            if (typeof entry !== "number") return { names, truncated: false };
            const name = readCString(entry, nameOffset);
            if (name === "." || name === "..") continue;
            if (names.length === operation.limit) return { names, truncated: true };
            names.push(name);
          }
        } finally {
          c.closedir(stream);
        }
      }
      case "close": {
        const fd = this.fds.get(operation.handle);
        if (fd === undefined) return 0;
        this.fds.delete(operation.handle);
        return integerResult(c.close(fd));
      }
      // Plain descriptor I/O, synchronous on this thread so a stuck read blocks only this root.
      case "fstat":
        return statFields(fstatSync(this.fd(operation.fd)));
      case "read": {
        const bytes = Buffer.alloc(operation.length);
        const count = readSync(
          this.fd(operation.fd),
          bytes,
          0,
          operation.length,
          operation.position,
        );
        return new Uint8Array(bytes.subarray(0, count));
      }
      case "write": {
        const { data } = operation;
        return writeSync(this.fd(operation.fd), data, 0, data.length, operation.position);
      }
      case "fsync":
        fsyncSync(this.fd(operation.fd));
        return 0;
      case "chmod":
        fchmodSync(this.fd(operation.fd), operation.mode);
        return 0;
      case "readLink": {
        const bytes = Buffer.alloc(4096);
        const count = integerResult(
          c.readlinkat(this.fd(operation.directory), cString(operation.name), bytes, bytes.length),
        );
        if (count < 1 || count >= bytes.length) return null;
        return bytes.subarray(0, count).toString("utf8");
      }
      case "mkdir":
        return integerResult(
          c.mkdirat(this.fd(operation.directory), cString(operation.name), operation.mode),
        );
      case "unlink":
        return integerResult(
          c.unlinkat(this.fd(operation.directory), cString(operation.name), operation.flags),
        );
      case "symlink":
        return integerResult(
          c.symlinkat(
            cString(operation.target),
            this.fd(operation.directory),
            cString(operation.name),
          ),
        );
      case "rename":
      case "link":
      case "renameFlags": {
        const from = this.fd(operation.from);
        const to = this.fd(operation.to);
        const fromName = cString(operation.fromName);
        const toName = cString(operation.toName);
        if (operation.op === "rename") return integerResult(c.renameat(from, fromName, to, toName));
        if (operation.op === "link")
          return integerResult(c.linkat(from, fromName, to, toName, operation.flags));
        return integerResult(c.renameFlags(from, fromName, to, toName, operation.flags));
      }
      case "lstatPath":
        return statFields(lstatSync(operation.path));
      case "statPath":
        return statFields(statSync(operation.path));
      case "realpath":
        return realpathSync(operation.path);
      case "readdirPath":
        return readdirSync(operation.path).slice(0, operation.limit);
      case "mkdirPath":
        mkdirSync(operation.path, { recursive: true });
        return 0;
      case "readPathNoFollow":
        return this.readNoFollow(operation.path, operation.limit);
    }
  }

  /** `/` then each component, with O_NOFOLLOW: a component swapped for a link fails closed. */
  private walk(path: string): number {
    const c = posixBindings();
    const parts = path.split("/").filter(Boolean);
    if (parts.length > 128) throw new Error("Trusted root depth limit");
    let fd = integerResult(c.openat(-100, cString("/"), directoryFlags));
    for (const part of parts) {
      if (fd < 0) return -1;
      const child = integerResult(c.openat(fd, cString(part), directoryFlags));
      c.close(fd);
      fd = child;
    }
    return fd;
  }

  private readNoFollow(path: string, limit: number): Uint8Array<ArrayBuffer> {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > limit) throw tooLarge();
      const bytes = Buffer.alloc(limit + 1);
      let offset = 0;
      for (;;) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) break;
        offset += count;
        if (offset > limit) throw tooLarge();
      }
      return new Uint8Array(bytes.subarray(0, offset));
    } finally {
      closeSync(fd);
    }
  }
}

const tooLarge = () =>
  Object.assign(new Error("Not a file within its size limit"), { code: "EFBIG" });
