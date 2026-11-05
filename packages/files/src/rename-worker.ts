// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { parentPort } from "node:worker_threads";
import { constants } from "node:os";
import { z } from "zod";
import { win32 } from "node:path";
import { openLibrary, readInt32, wideString, cString } from "@ace/provider-kit/bun-ffi";

const Request = z.object({
  source: z.string().min(1).max(16384),
  destination: z.string().min(1).max(16384),
});
type Reply = { ok: true } | { ok: false; code: string; message: string };
const integer = z.number().int();
/** The calling thread's errno, read right after the call that set it. */
function posixResult(result: unknown, errno: () => number): Reply {
  const code = integer.parse(result);
  if (code === 0) return { ok: true };
  const error = errno();
  const codes = constants.errno;
  return {
    ok: false,
    code:
      error === codes.EEXIST || error === codes.ENOTEMPTY
        ? "CONFLICT"
        : error === codes.EXDEV
          ? "EXDEV"
          : error === codes.ENOENT
            ? "NOT_FOUND"
            : error === codes.ENOSYS || error === codes.EINVAL || error === codes.ENOTSUP
              ? "UNSUPPORTED"
              : "IO_ERROR",
    message: "Exclusive rename failed",
  };
}
/** Windows: the `\\?\` form of an absolute path, which lifts MAX_PATH for Win32 calls. */
function windowsLongPath(path: string): string {
  return win32.toNamespacedPath(win32.resolve(path));
}
/** Bind once in this dedicated I/O worker; syscall and errno stay on the same thread. */
function systemMover(): (source: string, destination: string) => Reply {
  if (process.platform === "darwin") {
    const library = openLibrary("/usr/lib/libSystem.B.dylib", {
      renamex_np: { args: ["ptr", "ptr", "u32"], returns: "i32" },
      __error: { args: [], returns: "ptr" },
    });
    const { renamex_np: rename, __error: location } = library.symbols;
    const errno = () => readInt32(z.number().parse(location()));
    return (source, destination) =>
      posixResult(rename(cString(source), cString(destination), 4), errno); // RENAME_EXCL
  }
  if (process.platform === "linux") {
    const library = openLibrary("libc.so.6", {
      renameat2: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" },
      __errno_location: { args: [], returns: "ptr" },
    });
    const { renameat2: rename, __errno_location: location } = library.symbols;
    const errno = () => readInt32(z.number().parse(location()));
    // AT_FDCWD, RENAME_NOREPLACE
    return (source, destination) =>
      posixResult(rename(-100, cString(source), -100, cString(destination), 1), errno);
  }
  if (process.platform === "win32") {
    const library = openLibrary("kernel32.dll", {
      MoveFileExW: { args: ["ptr", "ptr", "u32"], returns: "i32" },
      GetLastError: { args: [], returns: "u32" },
    });
    const { MoveFileExW: rename, GetLastError: lastError } = library.symbols;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    // Flags 0: never replace and never copy across volumes.
    return (source, destination) => {
      for (let attempt = 0; ; attempt++) {
        const result = integer.parse(
          rename(wideString(windowsLongPath(source)), wideString(windowsLongPath(destination)), 0),
        );
        const error = integer.parse(lastError());
        if (result !== 0) return { ok: true };
        // Access denied (5) and sharing violations (32) clear once another program lets go.
        if ([5, 32].includes(error) && attempt < 5) {
          Atomics.wait(pause, 0, 0, 25 * 2 ** attempt);
          continue;
        }
        return {
          ok: false,
          code: [80, 183].includes(error)
            ? "CONFLICT"
            : error === 17
              ? "EXDEV"
              : [2, 3].includes(error)
                ? "NOT_FOUND"
                : "IO_ERROR",
          message: "Exclusive rename failed",
        };
      }
    };
  }
  return () => ({
    ok: false,
    code: "UNSUPPORTED",
    message: "Atomic no-replace rename is unavailable on this platform",
  });
}
let move: ReturnType<typeof systemMover> | undefined;
parentPort?.on("message", (raw: unknown) => {
  try {
    const request = Request.parse(raw);
    move ??= systemMover();
    parentPort?.postMessage(move(request.source, request.destination));
  } catch {
    parentPort?.postMessage({
      ok: false,
      code: "UNSUPPORTED",
      message: "Atomic no-replace rename could not be loaded",
    });
  }
});
