// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { parentPort } from "node:worker_threads";
import koffi from "koffi";
import { z } from "zod";

const Request = z.object({
  source: z.string().min(1).max(16384),
  destination: z.string().min(1).max(16384),
});
type Reply = { ok: true } | { ok: false; code: string; message: string };
const integer = z.number().int();
function posixResult(result: unknown): Reply {
  const code = integer.parse(result);
  const error = koffi.errno();
  if (code === 0) return { ok: true };
  const codes = koffi.os.errno;
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
/** Bind once in this dedicated I/O worker; syscall and errno stay on the same thread. */
function systemMover(): (source: string, destination: string) => Reply {
  if (process.platform === "darwin") {
    const library = koffi.load("/usr/lib/libSystem.B.dylib");
    const rename = library.func(
      "int renamex_np(const char *source, const char *destination, unsigned int flags)",
    );
    return (source, destination) => posixResult(rename(source, destination, 4)); // RENAME_EXCL
  }
  if (process.platform === "linux") {
    const library = koffi.load(null);
    const rename = library.func(
      "int renameat2(int sourcefd, const char *source, int destfd, const char *destination, unsigned int flags)",
    );
    return (source, destination) => posixResult(rename(-100, source, -100, destination, 1)); // AT_FDCWD, RENAME_NOREPLACE
  }
  if (process.platform === "win32") {
    const library = koffi.load("kernel32.dll");
    const rename = library.func(
      "int __stdcall MoveFileExW(str16 source, str16 destination, unsigned int flags)",
    );
    const lastError = library.func("unsigned int __stdcall GetLastError(void)");
    return (source, destination) => {
      const result = integer.parse(rename(source, destination, 0));
      const error = integer.parse(lastError());
      return result !== 0
        ? { ok: true }
        : {
            ok: false,
            code: [80, 183].includes(error) ? "CONFLICT" : error === 17 ? "EXDEV" : "IO_ERROR",
            message: "Exclusive rename failed",
          };
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
