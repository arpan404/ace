// What the koffi stand-ins (koffi.process.test.ts) report: native calls made through the koffi
// the app ships, resolved the way the main process resolves it.
import { loadKoffi } from "@ace/provider-kit/koffi";
import { windowsSystemExecutable } from "@ace/provider-kit/process-owner";

export type KoffiFacts = { pid: number; taskkill?: string };

/** This process's id from the OS (kernel32 on Windows, libc elsewhere), and on Windows taskkill's path. */
export function koffiFacts(): KoffiFacts {
  const koffi = loadKoffi();
  const windows = process.platform === "win32";
  const library = koffi.load(
    windows ? "kernel32.dll" : process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6",
  );
  try {
    const pid = Number(
      library.func(windows ? "uint __stdcall GetCurrentProcessId()" : "int getpid()")(),
    );
    // The tree stop's own System32 lookup, which binds kernel32 through koffi off Bun.
    return windows ? { pid, taskkill: windowsSystemExecutable("taskkill.exe") } : { pid };
  } finally {
    library.unload();
  }
}
