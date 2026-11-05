import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  readSync,
  writeSync,
} from "node:fs";
import { cString, openLibrary, readCString, type NativeFunction } from "@ace/provider-kit/bun-ffi";
import { openAt } from "@ace/workspace/descriptor";
import type { PosixOperation, PosixValue } from "./posix-wire.ts";

export type { PosixValue };

// OS interface declarations only. No provider or third-party implementation code.
function bindings() {
  if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch))
    throw new Error("Secure command discovery requires 64-bit macOS or Linux");
  const darwin = process.platform === "darwin";
  const suffix = darwin && process.arch === "x64" ? "$INODE64" : "";
  // renameatx_np (macOS) and renameat2 (Linux) take the same arguments; only flag values differ.
  const renameFlags = darwin ? "renameatx_np" : "renameat2";
  const library = openLibrary(darwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    openat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    readlinkat: { args: ["i32", "ptr", "ptr", "u64"], returns: "i64_fast" },
    mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
    renameat: { args: ["i32", "ptr", "i32", "ptr"], returns: "i32" },
    unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    linkat: { args: ["i32", "ptr", "i32", "ptr", "i32"], returns: "i32" },
    symlinkat: { args: ["ptr", "i32", "ptr"], returns: "i32" },
    [renameFlags]: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" },
    [`fdopendir${suffix}`]: { args: ["i32"], returns: "ptr" },
    [`readdir${suffix}`]: { args: ["ptr"], returns: "ptr" },
    closedir: { args: ["ptr"], returns: "i32" },
    close: { args: ["i32"], returns: "i32" },
  });
  const bound = (name: string): NativeFunction => {
    const fn = library.symbols[name];
    if (!fn) throw new Error(`Missing native function ${name}`);
    return fn;
  };
  return {
    openat: bound("openat"),
    readlinkat: bound("readlinkat"),
    mkdirat: bound("mkdirat"),
    renameat: bound("renameat"),
    unlinkat: bound("unlinkat"),
    linkat: bound("linkat"),
    symlinkat: bound("symlinkat"),
    closedir: bound("closedir"),
    close: bound("close"),
    renameFlags: bound(renameFlags),
    fdopendir: bound(`fdopendir${suffix}`),
    readdir: bound(`readdir${suffix}`),
  };
}
let native: ReturnType<typeof bindings> | undefined;

// Open directory streams by reader id; DIR pointers never leave this thread.
const readers = new Map<number, number>();
let nextReader = 0;
// Public dirent ABIs: Linux 64-bit d_name at 19; Darwin inode64 at 21.
const nameOffset = process.platform === "darwin" ? 21 : 19;

function integerResult(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error("Native call returned a non-integer");
  return value;
}

/**
 * Runs one descriptor-relative call on this thread: the POSIX worker's only job, so a stalled
 * network or FUSE mount blocks the worker, never the daemon's event loop.
 */
export function runPosixOperation(operation: PosixOperation): PosixValue {
  const c = (native ??= bindings());
  switch (operation.op) {
    case "open":
      // Without O_CREAT, openat reads no mode, so its variadic tail is never passed.
      return integerResult(c.openat(operation.directory, cString(operation.name), operation.flags));
    case "create":
      // openat with O_CREAT takes its mode as a variadic argument, which bun:ffi cannot pass
      // (and Apple's arm64 ABI passes on the stack). @ace/workspace's add-on creates it, 0600.
      try {
        return openAt(operation.directory, operation.name, operation.flags | constants.O_CREAT).fd;
      } catch {
        return -1;
      }
    case "openDirectory": {
      // The descriptor is this call's from here on: the stream owns it, or it closes now.
      let handle: unknown;
      try {
        handle = c.fdopendir(operation.fd);
      } finally {
        if (typeof handle !== "number") closeSync(operation.fd);
      }
      if (typeof handle !== "number") return 0;
      readers.set(++nextReader, handle);
      return nextReader;
    }
    case "readDirectory": {
      const handle = readers.get(operation.reader);
      if (handle === undefined) throw new Error("Unknown directory reader");
      const entry: unknown = c.readdir(handle);
      return typeof entry === "number" ? readCString(entry, nameOffset) : null;
    }
    case "closeDirectory": {
      const handle = readers.get(operation.reader);
      if (handle === undefined) return 0;
      readers.delete(operation.reader);
      return integerResult(c.closedir(handle));
    }
    case "closeFd":
      return integerResult(c.close(operation.fd));
    // Plain descriptor I/O, synchronous on this thread so a stuck read blocks only this root.
    case "fstat": {
      const stat = fstatSync(operation.fd);
      const { dev, ino, mode, size, mtimeMs, ctimeMs } = stat;
      return { dev, ino, mode, size, mtimeMs, ctimeMs };
    }
    case "read": {
      const bytes = Buffer.alloc(operation.length);
      const count = readSync(operation.fd, bytes, 0, operation.length, operation.position);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, count);
    }
    case "write":
      return writeSync(operation.fd, operation.data, 0, operation.data.length, operation.position);
    case "fsync":
      fsyncSync(operation.fd);
      return 0;
    case "chmod":
      fchmodSync(operation.fd, operation.mode);
      return 0;
    case "readLink": {
      const bytes = Buffer.alloc(4096);
      const count = integerResult(
        c.readlinkat(operation.directory, cString(operation.name), bytes, bytes.length),
      );
      if (count < 1 || count >= bytes.length) return null;
      return bytes.subarray(0, count).toString("utf8");
    }
    case "mkdir":
      return integerResult(c.mkdirat(operation.directory, cString(operation.name), operation.mode));
    case "unlink":
      return integerResult(
        c.unlinkat(operation.directory, cString(operation.name), operation.flags),
      );
    case "symlink":
      return integerResult(
        c.symlinkat(cString(operation.target), operation.directory, cString(operation.name)),
      );
    case "rename":
      return integerResult(
        c.renameat(
          operation.from,
          cString(operation.fromName),
          operation.to,
          cString(operation.toName),
        ),
      );
    case "link":
      return integerResult(
        c.linkat(
          operation.from,
          cString(operation.fromName),
          operation.to,
          cString(operation.toName),
          operation.flags,
        ),
      );
    case "renameFlags":
      return integerResult(
        c.renameFlags(
          operation.from,
          cString(operation.fromName),
          operation.to,
          cString(operation.toName),
          operation.flags,
        ),
      );
  }
}

/**
 * Releases what this thread owns before it exits: the result of its abandoned last call (never
 * delivered, so no one else holds that number) and every directory stream, each of which owns
 * the descriptor it was opened on.
 */
export function releasePosixState(
  abandoned: { operation: PosixOperation; value: PosixValue } | undefined,
): void {
  const c = native;
  if (!c) return;
  if (abandoned && typeof abandoned.value === "number") {
    const { operation, value } = abandoned;
    if ((operation.op === "open" || operation.op === "create") && value >= 0) c.close(value);
  }
  for (const handle of readers.values()) c.closedir(handle);
  readers.clear();
}
